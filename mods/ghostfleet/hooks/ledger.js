// The request ledger's vocabulary, as plain functions: no `$`, no I/O. The LEDGER section
// of register.js uses them; bin/fleet-ledger reads and writes the same file through them,
// and test/run.sh imports this file with node.
//
// <fleet dir>/<session_id>.ledger   (JSON, but deliberately NOT named *.json: eight readers
//                                    glob <fleet dir>/*.json as status records)
//   { v: 1, seq, items: [ { id, text, at, turnId, state, source, ... } ], judge? }
//
//   state    open | done | not-done | stale (a promise no judged turn addressed, see STALE_TURNS)
//   source   user     typed at the prompt (or the phone's bridge), idle or mid-turn
//            fleet    a prompt fleet-send handed to the mod (DELIVERY)
//            promise  a commitment the agent made in a final message ("I'll merge when green")
//   gated    true once the gate has re-prompted about it: at most once per item, ever
//   queued   typed over a running turn; interrupted: its turn was stopped (Esc). Either may
//            never have reached the model, and the gate asks the transcript first
//   closedBy judge | hand

export const LEDGER_VERSION = 1
export const KEEP_ITEMS = 200                 // the file keeps the newest 200
export const BAND_DAYS = 7                    // older than this drops off the band and the gate
export const EXCERPT = 240                    // a request's text as kept
const DAY_MS = 86_400_000

export const ledgerFile = (dir, sessionId) => `${dir}/${sessionId}.ledger`

export const emptyLedger = () => ({ v: LEDGER_VERSION, seq: 0, items: [] })

// A file that is missing, torn or someone else's shape reads as empty, never as a throw.
export function parseLedger(text) {
  try {
    const l = JSON.parse(text)
    if (l && typeof l === 'object' && Array.isArray(l.items)) return { ...emptyLedger(), ...l, items: l.items.filter(i => i && i.id) }
  } catch {}
  return emptyLedger()
}

// The switches, from the environment (a settings file's `env` block lands there too).
//   CLAUDE_FLEET_LEDGER=off               the whole feature
//   CLAUDE_FLEET_LEDGER_GATE=off          record and show, never re-prompt
//   CLAUDE_FLEET_LEDGER_PROMISES=show|gate|off   (default show)
export function ledgerConfig(get) {
  const off = v => /^(off|0|false|no)$/i.test(String(v || '').trim())
  const p = String(get('CLAUDE_FLEET_LEDGER_PROMISES') || 'show').trim().toLowerCase()
  return {
    on: !off(get('CLAUDE_FLEET_LEDGER')),
    gate: !off(get('CLAUDE_FLEET_LEDGER_GATE')),
    promises: p === 'gate' || p === 'off' ? p : 'show',
    model: String(get('CLAUDE_FLEET_LEDGER_MODEL') || 'haiku').trim() || 'haiku',
  }
}

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim()
export const excerpt = (s, n = EXCERPT) => {
  const t = oneLine(s)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// What a message asks, in the person's own words. A message is often mostly material: a
// pasted transcript or log with a line of the person's around it. Kept as typed, the item's
// excerpt was the paste's first lines, the person's words were cut off past the excerpt,
// and the judge, shown a pasted draft and a pasted ledger reminder, judged THOSE: measured
// live, "u see what it just did <a pasted turn> its like reminding literally the last
// response" was re-prompted as an open request. So the pastes are set aside (marked, so the
// judge knows something was pasted) and so is any ledger reminder quoted in the text: it is
// this mod's own words, never the person's request. A message that is nothing but a quoted
// reminder is no request at all ('').
const PASTE = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content\b[^>]*>|$)/g
const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g
const REMINDER = [
  /(?:The ghostfleet plugin sent a message:\s*)?\[ghostfleet ledger\][\s\S]*?(?:it will not be asked again\.\)|$)/g,
  /This is how Claude Code surfaces a prompt a plugin submits between turns[^\n]*/g,
]
const unquote = t => REMINDER.reduce((a, re) => a.replace(re, ' '), t)
export function requestText(text) {
  const pastes = []
  const own = oneLine(unquote(String(text || '').replace(PASTE, m => { pastes.push(m.replace(PASTE_TAG, ' ')); return ' ' })))
  if (!pastes.length) return own
  if (own) return `${own} [+ pasted text]`
  const pasted = oneLine(unquote(pastes.join(' ')))
  return pasted ? `[pasted] ${pasted}` : ''
}

// A request as an item keeps its start AND its end. A paste the composer shows inline carries
// no marker, and the person's own words come after it: measured live, a three-line draft and
// "what do u think" was kept as the draft's opening lines, the judge read the request as
// "write the draft", and an answered question was re-prompted. The start stays the longer
// part (the withdrawn check matches on an item's opening words).
const ITEM_HEAD = 140
export function requestItem(text) {
  const t = requestText(text)
  return t.length > EXCERPT ? `${t.slice(0, ITEM_HEAD - 1)}… ${t.slice(-(EXCERPT - ITEM_HEAD - 1))}` : t
}

// Which submitted prompts are requests, and whose. Only the person's: composer, the phone's
// bridge, and what the engine cannot attest (`unclassified`). This mod's own submits are
// never read here: a fleet-send handoff is recorded by DELIVERY at the turn it started (it
// knows the turn exactly), and the gate's re-prompt must never become an item of its own,
// which would be a loop with extra steps. Everything else (a background task's
// notification, a /loop firing, a peer's message) is not a request somebody is waiting on.
// A slash command is an instruction to the harness, not work for the agent.
export function sourceOf(e) {
  const text = String(e && e.text || '')
  if (!requestText(text) || text.trimStart().startsWith('/')) return null
  const o = (e && e.origin) || { kind: 'composer' }
  return o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'unclassified' ? 'user' : null
}

// A request submitted idle names its turn at that turn's start, which carries its text.
export function stampTurn(ledger, text, turnId) {
  const t = String(text || '').trim()
  const i = ledger.items.findIndex(x => x.state === 'open' && !x.turnId && x.source !== 'promise' && x.text === requestItem(t))
  if (!t || i < 0) return null
  return { ...ledger, items: ledger.items.map((x, k) => (k === i ? { ...x, turnId } : x)) }
}

// `queued`: typed over a running turn. Such a message can still be pulled back out of the
// queue (Up edits it) and never reach the model; see `withdrawn` below.
export function addItem(ledger, { text, at, turnId, source, queued }) {
  const seq = (Number(ledger.seq) || 0) + 1
  const item = { id: String(seq), text: source === 'promise' ? excerpt(text) : requestItem(text), at, ...(turnId ? { turnId } : {}), state: 'open', source, ...(queued ? { queued: true } : {}) }
  const items = [...ledger.items, item].slice(-KEEP_ITEMS)
  return { ...ledger, seq, items }
}

const fresh = (i, nowMs) => nowMs - (Number(i.at) || 0) <= BAND_DAYS * DAY_MS
export const openItems = (ledger, nowMs) => ledger.items.filter(i => i.state === 'open' && fresh(i, nowMs))

// What the record and the band say: open requests, open promises, the oldest open of each.
export function ledgerSummary(ledger, nowMs) {
  const open = openItems(ledger, nowMs)
  const req = open.filter(i => i.source !== 'promise')
  const prom = open.filter(i => i.source === 'promise')
  const oldest = list => list.length ? { id: list[0].id, text: excerpt(list[0].text, 80), at: list[0].at } : null
  // A failure is shown while something is open: with nothing open it has cost nothing, and
  // a hand-cleared ledger would otherwise go on saying so until the next judged turn.
  const j = req.length || prom.length ? ledger.judge : null
  return {
    open: req.length, promises: prom.length, oldest: oldest(req), oldestPromise: oldest(prom),
    judgeFailing: j && j.ok === false ? excerpt(j.why, 80) : null,
  }
}

// Is there anything for the judge? Open items, or an answer that sounds like a commitment.
// The regex is only a cheap door in front of the model call, never the decision: it lets a
// turn that promises nothing go by without one.
const PROMISE_WORDS = /\b(I'll|I will|I'm going to|I am going to|next,? I|then I|once .{1,60}(I'll|I will)|when .{1,60}(I'll|I will)|later|after (that|this|CI|the))\b/i
export const soundsLikeAPromise = answer => PROMISE_WORDS.test(String(answer || ''))

// What a turn said: every text block it wrote, in order, one per model step that wrote any.
// `turn.complete`'s `answer` is only the LAST of them, and judged alone it lost the work:
// a turn wrote a post in its first block, ran two commands, and ended "the draft is above",
// and the judge, shown that line with nothing above it, kept the request open and the gate
// re-prompted for a reply the person had just read. `steps` are the texts the turn's steps
// returned; `answer` is the turn's final text, the whole record when the steps were missed
// (the module reloaded mid-turn) and appended when the last step did not end on it.
export function turnBlocks(steps, answer) {
  const blocks = (steps || []).map(s => String(s || '')).filter(s => s.trim())
  const last = String(answer || '')
  if (last.trim() && (!blocks.length || blocks[blocks.length - 1].trim() !== last.trim())) blocks.push(last)
  return blocks
}

// The turn as the judge reads it: each block labelled with its place, and a long turn cut
// from the MIDDLE. The start is where the work tends to be (the draft, the answer) and the
// end is where the turn reports; a tail-only cut drops exactly the half the report points at.
const HEAD_SHARE = 0.4
export function middleCut(s, n) {
  const a = String(s || '')
  if (a.length <= n) return a
  const head = Math.floor(n * HEAD_SHARE)
  const tail = n - head
  return `${a.slice(0, head)}\n[… ${a.length - head - tail} characters from the middle of the turn left out …]\n${a.slice(-tail)}`
}
export function turnText(blocks, n) {
  const list = typeof blocks === 'string' ? [blocks] : blocks || []
  const text = list.length > 1 ? list.map((b, k) => `[block ${k + 1} of ${list.length}]\n${b}`).join('\n\n') : String(list[0] || '')
  return middleCut(text, n)
}

// The one judge call: which open items the turn addressed, and what it promised. Inputs are
// truncated: item texts to EXCERPT, the turn to ANSWER_CHARS, an earlier turn to EARLIER_CHARS.
// `turn` is the turn's blocks (turnBlocks), or one string for a turn of one block.
export const ANSWER_CHARS = 6000
export const EARLIER_CHARS = 1500
export function judgePrompt(items, turn, { promises, earlier = [] }) {
  const blocks = typeof turn === 'string' ? [turn] : turn || []
  const tail = turnText(blocks, ANSWER_CHARS)
  const final = blocks.length > 1 ? `the LAST block (${blocks.length} of ${blocks.length})` : 'the message'
  const before = earlier.slice(-2).map(t => turnText(t, EARLIER_CHARS))
  const list = items.length
    ? items.map(i => `${i.id} [${i.source === 'promise' ? 'promise the agent made' : 'request to the agent'}]: ${excerpt(i.text)}`).join('\n')
    : '(none)'
  return [
    'You audit an AI coding agent. Below are items it owes, and everything it wrote in the turn it just ended.',
    '',
    'ITEMS:',
    list,
    '',
    ...(before.length ? ['EARLIER TURNS (oldest first; an item answered here is answered):', ...before.map(t => `<<<\n${t}\n>>>`), ''] : []),
    `THIS TURN (every text block the agent wrote, in order; its tool calls and their output ran between blocks and are left out; ${final} is how it ended):`,
    '<<<',
    tail,
    '>>>',
    '',
    'For EACH item decide:',
    '- "done": the turn (any block of it) or an earlier turn did it, answered it, or reports it completed. Work written in an earlier block counts: "the draft is above" in the last block refers to a draft in an earlier one.',
    '- "done" also, with reason "reported: waiting on <what>", when the agent did everything it can do now and says plainly that the rest waits on something outside its control (CI running, a registry or deploy propagating, a review, the person\'s own action), and what happens next. Work the agent could have done itself and simply did not is not this: it is "open".',
    '- "not-done": the agent explicitly says THIS item was not or cannot be done AND gives a reason. A refusal with no reason, or one that does not say which request it means, is "open".',
    '- "open": anything else: not mentioned, only acknowledged, or partly done with no report of why the rest is waiting.',
    'Judge an item by what it asked for NOW: a part it explicitly put off ("not in this reply", "later", "after X") is not owed yet.',
    'An item may open with material the person pasted with no marker (a draft, a log, a transcript) and end with their own words: judge what THOSE words ask. A question ("what do you think?") is "done" once the agent answers it; an answer that ends by offering more or asking something back does not reopen it.',
    'An item is the person\'s own words. "[+ pasted text]" means they also pasted material (a transcript, a log, an earlier reply) as context for those words: the material is not a request of its own, and a "[ghostfleet ledger]" reminder quoted in it is this tool talking, never a request. Judge what the person\'s own words ask; a remark about the paste ("see what it did") asks for the agent to look at it, and is done once the agent has.',
    'An item that only approves, confirms or thanks ("go ahead", "yes", "thanks") asks for no work of its own: it is "done" once the agent acts on what it approved, or if there is nothing to act on. An item that confirms AND asks ("done, now draft the post") is judged by what it asks.',
    promises === 'off'
      ? 'Return "promises": [] always.'
      : `Also list "promises", from ${final} only: things the agent says IT WILL DO LATER in this session ("I'll merge once CI is green", "next I'll add the tests"), each as a short imperative phrase of at most 12 words. Only a firm commitment to a specific action: not work it already did, not suggestions for the user, not questions, not offers that wait on the user ("I can do X if you'd like"), not statements about how it will behave in general ("I'll keep responding normally"). [] if none.`,
    '',
    'Reply with ONLY this JSON, no prose, no code fence:',
    '{"items":[{"id":"<id>","status":"done|not-done|open","reason":"<at most 12 words>"}],"promises":["..."]}',
  ].join('\n')
}

// The judge's reply, held to the shape asked for. null when nothing in it has that shape: the
// gate fails OPEN on null (nothing closes, nothing is re-prompted).
//
// A reply cut off by its token budget still carries every item object it finished. Measured
// live: a ledger of 46 open items asked for 46 verdicts in 700 tokens, the reply stopped
// partway through, and dropping the whole reply on its missing brace closed nothing, so the
// backlog only grew and every later turn failed the same way. So the finished objects are
// kept, `partial` says the reply was cut, and an item it never reached is simply not judged.
const ITEM_OBJ = /\{[^{}]*"id"[^{}]*\}/g
export function parseVerdict(text, ids) {
  const s = String(text || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0) return null
  let v = null
  if (b > a) try { v = JSON.parse(s.slice(a, b + 1)) } catch {}
  let partial = false
  if (!v || typeof v !== 'object' || !Array.isArray(v.items)) {
    const list = s.indexOf('"items"', a)
    if (list < 0) return null
    const found = []
    for (const m of s.slice(list).matchAll(ITEM_OBJ)) { try { found.push(JSON.parse(m[0])) } catch {} }
    if (!found.length) return null
    // the promises list, when the reply got as far as closing it
    const pm = s.match(/"promises"\s*:\s*(\[[^\]]*\])/)
    let promises = []
    if (pm) try { promises = JSON.parse(pm[1]) } catch {}
    v = { items: found, promises }
    partial = true
  }
  const known = new Set(ids)
  const items = []
  for (const it of v.items) {
    if (!it || !known.has(String(it.id))) continue
    const status = String(it.status || '')
    if (!['done', 'not-done', 'open'].includes(status)) continue
    items.push({ id: String(it.id), status, reason: excerpt(it.reason, 120) })
  }
  if (partial && !items.length) return null
  const promises = Array.isArray(v.promises)
    ? v.promises.map(p => excerpt(p, 120)).filter(Boolean).slice(0, 3) : []
  return { items, promises, ...(partial ? { partial: true } : {}) }
}

// The judge asks about at most JUDGE_BATCH items per call, the newest first. One verdict is
// one {"id","status","reason"} object per item, 25-40 tokens each, so a ledger of 46 items
// asked in one call needs ~1,600 tokens of reply against a budget of 700, and is cut off.
// Ten items is ~400 at the high end, plus three promises, inside 700 with room to spare.
export const JUDGE_BATCH = 10
export const JUDGE_TOKENS = 700
export function judgeBatches(items, n = JUDGE_BATCH) {
  const newest = [...items].sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0) || Number(y.id) - Number(x.id))
  const out = []
  for (let k = 0; k < newest.length; k += n) out.push(newest.slice(k, k + n))
  return out
}

// A promise is not gated by default, it is only shown, and one no turn ever addresses would
// stay on the band for the full BAND_DAYS. So a promise the judge was shown and kept open in
// STALE_TURNS judged turns closes as `stale`. Five: a "once CI is green" spans a turn or two
// of other work; five turns that never mention it is a commitment the session has dropped.
export const STALE_TURNS = 5

// The verdict applied: judged items close, promises join as items of their own (one with the
// same words as an open promise is that promise, not a second one).
export function applyVerdict(ledger, verdict, { nowMs, turnId, promises }) {
  const by = new Map(verdict.items.map(i => [i.id, i]))
  let next = {
    ...ledger,
    items: ledger.items.map(i => {
      const v = by.get(i.id)
      if (!v || i.state !== 'open') return i
      if (v.status === 'open') {
        if (i.source !== 'promise') return i
        const kept = (Number(i.keptOpen) || 0) + 1
        return kept < STALE_TURNS ? { ...i, keptOpen: kept }
          : { ...i, keptOpen: kept, state: 'stale', closedAt: nowMs, closedBy: 'judge', reason: `no turn addressed it in ${kept} judged turns` }
      }
      return { ...i, state: v.status, closedAt: nowMs, closedBy: 'judge', ...(v.reason ? { reason: v.reason } : {}) }
    }),
  }
  if (promises !== 'off') {
    const have = new Set(next.items.filter(i => i.source === 'promise' && i.state === 'open').map(i => i.text.toLowerCase()))
    for (const p of verdict.promises) {
      if (have.has(p.toLowerCase())) continue
      have.add(p.toLowerCase())
      next = addItem(next, { text: p, at: nowMs, turnId, source: 'promise' })
    }
  }
  return next
}

// The items the gate may re-prompt about: open, fresh, never gated before; promises only
// when promises gate.
export function gateTargets(ledger, nowMs, { promises }) {
  return openItems(ledger, nowMs).filter(i => !i.gated && (i.source !== 'promise' || promises === 'gate'))
}

// The queued items the model never received. A message typed over a running turn fires
// prompt.submit at Enter and is then queued; Up pulls it back into the composer, and nothing
// raises an event for that. Measured: the gate then re-prompted about a message the model
// had never seen, and the model rightly said it was never asked. So before a re-prompt, a
// queued item has to be found among the session's user messages; one that is not, with the
// session idle and no later turn started, was withdrawn. (Resubmitted, it is a new item.)
// Matched on the item's opening words: the item keeps an excerpt, the transcript the whole.
//
// An INTERRUPTED item is asked the same. Esc before the turn wrote anything rewinds the
// message out of the conversation and hands it back to the composer; sent again, edited or
// not, it is a second prompt.submit and so a second item. Measured live: one message the
// person sent once (to their mind) was two items with the same excerpt, and the gate named
// both. The transcript held one copy, the resend; the first was a sibling of it, off the
// conversation. So one message in the transcript accounts for one item: an item is
// withdrawn when the items from it onward that carry its words outnumber the messages that
// do, and the newest keep the messages. Two sends of the same words that both reached the
// model are two messages, and stay two items.
//   `all`: every item in the ledger, which the later items are counted from.
export function withdrawn(items, userTexts, all = items) {
  const norm = t => oneLine(t).toLowerCase()
  const texts = userTexts.map(t => norm(requestText(t)))
  const asks = all.filter(i => i.source !== 'promise')
  return items.filter(i => (i.queued || i.interrupted) && i.source !== 'promise').filter(i => {
    const head = norm(i.text).replace(/…$/, '').split('…')[0].slice(0, 80)
    if (!head) return false
    const said = texts.filter(t => t.includes(head)).length
    const from = asks.filter(x => Number(x.id) >= Number(i.id) && norm(x.text).includes(head)).length
    return said < from
  }).map(i => i.id)
}

// The person's items of a turn that was interrupted: the gate asks the transcript about
// them before naming any (see `withdrawn`).
export function markInterrupted(ledger, turnId) {
  if (!turnId || !ledger.items.some(i => i.turnId === turnId && i.state === 'open' && i.source !== 'promise')) return null
  return {
    ...ledger,
    items: ledger.items.map(i => (i.turnId === turnId && i.state === 'open' && i.source !== 'promise' ? { ...i, interrupted: true } : i)),
  }
}

export const dropItems = (ledger, ids) => ({ ...ledger, items: ledger.items.filter(i => !ids.includes(i.id)) })

export function gatePrompt(items) {
  const lines = items.map(i => `${i.id}. ${i.source === 'promise' ? '(you said you would) ' : ''}"${excerpt(i.text, 160)}"`)
  return [
    `[ghostfleet ledger] ${items.length === 1 ? 'One request is' : `${items.length} requests are`} still open from this session:`,
    ...lines,
    'Finish each one now, or say for each that it is not done and why. (Asked once per item; it will not be asked again.)',
  ].join('\n')
}

export const markGated = (ledger, ids, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (ids.includes(i.id) ? { ...i, gated: true, gatedAt: nowMs } : i)),
})

// By hand: `fleet-ledger close <id>` and `/ledger close <id>`. null when there is no such
// open item.
export function closeByHand(ledger, id, nowMs) {
  const it = ledger.items.find(i => i.id === String(id))
  if (!it || it.state !== 'open') return null
  return {
    ...ledger,
    items: ledger.items.map(i => (i === it ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'hand' } : i)),
  }
}

// `clear` closes every open item by hand; the history stays in the file.
export const clearOpen = (ledger, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (i.state === 'open' ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'hand' } : i)),
})

const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

// The listing both the CLI and /ledger print.
export function listing(ledger, nowMs, { all = false } = {}) {
  const rows = (all ? ledger.items : openItems(ledger, nowMs))
  const j = ledger.judge
  const judged = !j ? [] : [j.ok
    ? `last judge: ok${j.items ? `, ${j.items} item${j.items === 1 ? '' : 's'} in ${j.calls || 1} call${(j.calls || 1) === 1 ? '' : 's'}` : ''} (${ago(nowMs - j.at)} ago)`
    : `last judge: FAILING, failed open: ${j.why} (${ago(nowMs - j.at)} ago)`]
  if (!rows.length) return [all ? 'ledger: empty' : 'ledger: nothing open', ...judged].join('\n')
  const out = rows.map(i => {
    const tag = i.source === 'promise' ? 'promise' : i.source
    const why = i.reason ? `  (${i.reason})` : ''
    return `${i.id.padStart(3)}  ${i.state.padEnd(8)} ${tag.padEnd(7)} ${ago(nowMs - i.at).padStart(4)}  ${excerpt(i.text, 100)}${i.gated ? '  [gated]' : ''}${why}`
  })
  return [...out, ...judged].join('\n')
}

// The band's ledger row as text runs, the longest form that fits `columns`:
//   ledger · 2 open · oldest 4m "fix the login redirect…" · promise: merge when green
// Narrower, the quote goes, then the promise's words, then everything but the counts. A judge
// whose last call failed says so first, at every width: a failing judge closes nothing, and
// a count that only grows was all the band showed of it.
//   ledger · judge failing: reply was not the JSON asked for · 24 open · …
export const LEDGER_COLOR = { open: '#ffd75f', promise: '#87afd7', failing: '#ff5f5f' }
export function ledgerRuns(s, nowMs, columns) {
  if (!s || (!s.open && !s.promises && !s.judgeFailing)) return null
  const cols = Math.max(1, Number(columns) || 80)
  const sep = { text: ' · ', dim: true }
  const head = { text: 'ledger', dim: true }
  const open = s.open ? { text: `${s.open} open`, color: LEDGER_COLOR.open, bold: true } : null
  const fail = n => (s.judgeFailing
    ? { text: n ? `judge failing: ${excerpt(s.judgeFailing, n)}` : 'judge failing', color: LEDGER_COLOR.failing, bold: true }
    : null)
  const age = s.oldest ? ago(nowMs - s.oldest.at) : ''
  const quote = n => (s.oldest ? { text: `oldest ${age} “${excerpt(s.oldest.text, n)}”`, dim: true } : null)
  const prom = n => (s.promises
    ? { text: n && s.oldestPromise ? `promise: ${excerpt(s.oldestPromise.text, n)}${s.promises > 1 ? ` +${s.promises - 1}` : ''}`
      : `${s.promises} ${s.promises === 1 ? 'promise' : 'promises'}`, color: LEDGER_COLOR.promise }
    : null)
  const tiny = [
    s.judgeFailing ? { text: '✗', color: LEDGER_COLOR.failing, bold: true } : null,
    s.open ? { ...open, text: `${s.open}○` } : null,
    s.promises ? { text: `${s.promises}◇`, color: LEDGER_COLOR.promise } : null,
  ]
  const forms = [
    [head, fail(60), open, quote(48), prom(40)],
    [head, fail(40), open, quote(24), prom(24)],
    [head, fail(24), open, s.oldest ? { text: `oldest ${age}`, dim: true } : null, prom(0)],
    [head, fail(0), open, prom(0)],
    [fail(0), open, prom(0)],
    tiny,
    [tiny.find(Boolean)],
  ]
  let runs = null
  for (const parts of forms) {
    runs = parts.filter(Boolean).flatMap((r, i) => (i ? [sep, r] : [r]))
    if (runs.reduce((k, r) => k + [...r.text].length, 0) <= cols) return runs
  }
  return runs
}
