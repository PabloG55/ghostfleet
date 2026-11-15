// The request ledger's vocabulary, as plain functions: no `$`, no I/O. The LEDGER section
// of register.js uses them; bin/fleet-ledger reads and writes the same file through them,
// and test/run.sh imports this file with node.
//
// <fleet dir>/<session_id>.ledger   (JSON, but deliberately NOT named *.json: eight readers
//                                    glob <fleet dir>/*.json as status records)
//   { v: 1, seq, prompt, window, items: [ { id, text, at, turnId, state, source, ... } ], judge?, judged? }
//
//   judge    the LAST judged turn: what it cost and whether it failed (ledgerSummary reads it)
//   judged   every judged turn since `since`, summed (countJudge): what the judge costs, which
//            the last result alone could never say. fleet-meter --ledger adds these up
//
//   state    open | done | not-done | stale (a promise no judged turn addressed, see STALE_TURNS)
//            | dropped (the agent said it was not a real ask, or the person cancelled it)
//            | waiting (a judged turn said it waits on the PERSON: off the open list and the
//            gate until they speak to it, see waitsOnPersonNote)
//            | expired (stale and untouched for EXPIRE_DAYS, or waiting and untouched for
//              WAITING_EXPIRE_MS when it is not for the person: retired, not open, still
//              listed by `all` and still closable. What is for the person never expires)
//            | carried (its session was stopped and the item went to its lead, see carryItems)
//            | moved (its session went on under another profile's fleet dir, and the item with
//              it: this file is the copy left behind, see adoptLedger)
//            stale and waiting are DORMANT: not open, but a turn that mentions one has it
//            judged again (revisit), so work that finished later still closes it
//   source   user     typed at the prompt (or the phone's bridge), idle or mid-turn; or the
//                     owner's own words a sender that authenticated them handed over
//                     (fleet-send --owner, a handoff `kind: "owner"`: the phone, see deliverySource)
//            fleet    a prompt fleet-send handed to the mod (DELIVERY): a lead's brief
//            promise  a commitment the agent made in a final message ("I'll merge when green")
//            question a question the agent put to the PERSON at the end of a turn, one item per
//                     numbered question (turnQuestions): `n` its number there, `options` its
//                     choices, `answer` { text, at, option? } once they gave one. FOR YOU, below
//   for you  what waits on the person, kept apart from what the agent owes (forYou): an open
//            question, and a request the agent is holding for their pick, files or OK (waiting).
//            Never a `fleet` item, which is owed to the session that sent it, and never a
//            promise, which is the agent's own word. It never expires: it stays until the
//            person answers it or it is dropped (see FOR YOU)
//   explain  { askedAt, at?, text?, lang } on a for-you item: the person asked the session that
//            raised it to explain it in plain words, and what it said (explainPrompt)
//   gated    true once the gate has re-prompted about it: at most once per item, ever
//   answered { at, turnId, reason }: a `fleet` item the judge read as done. It stays OPEN:
//            a brief from the lead is done only with proof (needsProof); the gate asks for
//            that proof once (proofAskedAt, see proofTargets)
//   progress { at, turnId, reason }: a judged turn reported the item's state and said the
//            work goes on elsewhere (a worker, a build, CI) or waits on the person. It stays
//            open, listed and judged, and the gate never names it (gateTargets)
//   queued   typed over a running turn; interrupted: its turn was stopped (Esc). Either may
//            never have reached the model, and the gate asks the transcript first. A resend
//            within RESEND_MS of the stop is folded into the interrupted item (resendOf)
//   repeated how many more times the same words were sent while it was open, each within
//            REPEAT_MS of the last (`repeatedAt`): one ask, not one item per send (repeatOf)
//   replies  [{ at, text, source, asked }]: bare answers to a numbered question the agent asked
//            about it, who sent each and what was asked. A reply from before those two has neither
//   asked    on a `user` item: the numbered question the turn before it ended on, so this whole
//            message is the person's answer to it (ownerAnswers)
//   prompt   the number of the prompt that made it (ledger.prompt counts them); `window` is
//            the first prompt of the latest one, and only items from `window` on are gated.
//            An item from before this field existed has none, and is never gated again
//   carried  { from, sessionId, id, state, source, at, note, branch?, pr? }: on a LEAD's item,
//            the worker it came from when that worker was stopped, what the item was there,
//            and the worker's branch and open PR, when the stop knew them. Its source is
//            `fleet`, so it too is done only with proof (needsProof); the PR merging is that
//            proof (closeLanded)
//   closedBy agent (fleet-ledger close / drop, or ledger_close / ledger_drop, with `proof` or
//            `reason`) | judge (never `done` on a fleet item) | person (/ledger close,
//            fleet-ledger close <id>; `hand` in a file written before) | fleet-stop (its worker's
//            PR had merged, closeMerged) | fleet (a carried item's PR merged, closeLanded)
//   inTurn   true on a `user` item until the end of the turn that answers it (settleTurn): it
//            is judged as any open item, but owed (on the band, the record, the note, the
//            held list) only once it outlives that turn, or TURN_SCOPE_MS (see owed)

export const LEDGER_VERSION = 1
export const KEEP_ITEMS = 200                 // the file keeps the newest 200
export const BAND_DAYS = 7                    // older than this drops off the band and the gate
export const EXCERPT = 240                    // a request's text as kept
const DAY_MS = 86_400_000

export const ledgerFile = (dir, sessionId) => `${dir}/${sessionId}.ledger`

export const emptyLedger = () => ({ v: LEDGER_VERSION, seq: 0, items: [] })

// A file that is missing, torn or someone else's shape reads as empty, never as a throw. Each
// item is read through `reclassified`, so a file written before FOR YOU says what it holds by
// today's rule, whoever reads it and whether or not it is ever written again.
export function parseLedger(text) {
  try {
    const l = JSON.parse(text)
    if (l && typeof l === 'object' && Array.isArray(l.items)) return { ...emptyLedger(), ...l, items: awaitsHeld(l.items.filter(i => i && i.id).map(reclassified)) }
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
//   Each reminder pattern ends on words every form of that reminder has ended on, so a note or
// re-prompt quoted back from before the wording changed is stripped as surely as today's: the
// open-items note on "for an ask this list missed.", the re-prompts on "it will not be asked
// again.)". Change one of those endings and the pattern has to keep the old one too.
const PASTE = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content\b[^>]*>|$)/g
const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g
const REMINDER = [
  /(?:The ghostfleet plugin sent a message:\s*)?\[ghostfleet ledger\][\s\S]*?(?:it will not be asked again\.\)|$)/g,
  /This is how Claude Code surfaces a prompt a plugin submits between turns[^\n]*/g,
  /\[ghostfleet ledger: open items\][\s\S]*?(?:for an ask this list missed\.|$)/g,
  /\[ghostfleet ledger: waiting on the person\][\s\S]*?(?:into a summary line\.|$)/g,
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
  if (!requestText(text) || text.trimStart().startsWith('/') || isNudge(text)) return null
  const o = (e && e.origin) || { kind: 'composer' }
  return o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'unclassified' ? 'user' : null
}

// The fleet's own wake-ups, by their words. fleet-send --nudge marks one on the handoff
// (`kind: "nudge"`), and that marker is the first test; this one catches the nudge that came
// without it: one that fell back to the paste and arrived as typed text, and one an older
// fleet-send handed over unmarked. Measured on one lead's week: ten of its fourteen fleet items
// were the same "a worker finished, run fleet-inbox ... no need to reply to it" line, each
// judged, each listed. A message that says it needs no reply is not a request. Both halves,
// so a [fleet] message that relays a question still is one.
export const isNudge = text => /^\s*\[fleet\]/.test(String(text || '')) && /\bno need to reply\b/i.test(String(text || ''))

// WHOSE WORDS A DELIVERY CARRIES. A prompt fleet-send handed over is a lead's brief (`fleet`,
// done only with proof, needsProof) unless the sender that wrote the handoff authenticated the
// OWNER and said so (`kind: "owner"`): today the phone's server, whose request carried a token
// a passkey minted (bin/fleet-serve.mjs, through mcp/fleet-dispatch.mjs asOwner). Those are the
// person's own words typed on another keyboard, and under the proof rule each one the agent
// answered in prose stayed open and woke it to prove it had answered: measured, 82 proof
// prompts in 14 days. So they are `user`: split into asks and judged like a typed message.
// The mark is the test, never the wording, and nothing a caller passes can set it: the MCP
// tool has no field for it, and a worker's own fleet-send has to spell out --owner. A nudge
// is no item at all (null), and so is a request to explain an item (EXPLÍCAME below).
export const deliverySource = kind => (kind === 'nudge' || kind === 'explain' ? null : kind === 'owner' ? 'user' : 'fleet')

// The asks in one message, each an item of its own, so each can be closed on its own proof.
// A message of three asks kept as one item could only close when all three were done, and
// the agent closing it had to vouch for the two it did not mention. Split only where the
// split is plain: two or more sentences or list lines that each read as an ask (a list line,
// a question, a sentence that opens with a verb of work or a "can you"). A message with
// fewer is one item, exactly as it always was, and so is one with a paste in it (the paste's
// sentences are not the person's asks) or one long enough to be a pasted brief. The cheap
// side of the trade is deliberate: a miss is an ask the agent adds with ledger_add, while a
// false split is an item nobody asked for, which the gate would then re-prompt.
const ASK_VERB = /^(please\b|pls\b|can you|could you|would you|will you|can we|could we|let'?s|make sure|i need you|i want you|we need to|add|fix|build|write|rewrite|update|remove|delete|rename|run|rerun|re-run|test|check|review|merge|push|pull|open|close|create|make|send|show|tell|explain|find|look (at|into)|move|bump|change|refactor|document|deploy|publish|release|draft|summari[sz]e|list|compare|measure|verify|install|set up|clean|revert|commit|ship|wire|port|split|reply|answer|investigate|debug|profile|benchmark|translate|describe|generate|implement|try|shorten|trim|cut|edit|polish|format|lint|simplify|tighten|extend|convert|replace|swap|post|upload|share|save|schedule|plan|design|outline|research|read|search|fetch|download|start|stop|restart|retry|resend|confirm|count)\b/i
const ASK_ANYWHERE = /\b(please|can you|could you|need you to|want you to)\b/i
const LEAD_IN = /^(and|also|then|plus|so|oh and|and also)[, ]+/i
const RULE = /^(do not|don'?t|never|avoid|without|no need)\b/i
const STILL_ASKS = /^(do not|don'?t|never) forget\b/i
const LISTED = /^\s*(\d+[.)]|[-*•])\s+/
const SPLIT_MAX = 4000
const ASKS_MAX = 8
export function requestAsks(text) {
  const raw = String(text || '')
  const whole = requestItem(raw)
  if (!whole) return []
  if (PASTE.test(raw) || raw.length > SPLIT_MAX) { PASTE.lastIndex = 0; return [whole] }
  PASTE.lastIndex = 0
  const own = REMINDER.reduce((a, re) => a.replace(re, ' '), raw)
  const parts = own.split(/\n+/).flatMap(line => {
    const listed = LISTED.test(line)
    return line.replace(LISTED, '').split(/(?<=[.?!])\s+/).map((t, k) => ({ t: oneLine(t), listed: listed && k === 0 }))
  }).filter(x => x.t)
  const asks = []
  for (const { t, listed } of parts) {
    if (t.length < 6 || t.length > 300) continue
    const bare = t.replace(LEAD_IN, '')
    if (RULE.test(bare) && !STILL_ASKS.test(bare)) continue
    if (listed || t.endsWith('?') || STILL_ASKS.test(bare) || ASK_VERB.test(bare) || ASK_ANYWHERE.test(t)) asks.push(excerpt(t))
    if (asks.length >= ASKS_MAX) break
  }
  return asks.length >= 2 ? asks : [whole]
}

// A message, as items: one per ask (requestAsks), all carrying the message's prompt number.
// A message typed idle starts a new window, the one the gate may re-prompt about; one typed
// over a running turn joins the window that turn belongs to, since that turn's end is not
// gated (a queued message has started the next) and the next turn answers both.
// `ids`, when given, is filled with the new items' ids.
// The person's own items (`user`) are made turn-scoped (`inTurn`, see owed), and so is one a
// resend folds into: the stopped turn settled it, and the resend is the same instruction
// handed to a new turn. A brief from the lead is never turn-scoped.
//
// Before any item is made: a bare answer to the agent's own numbered question (`choiceTurn`,
// the turn that asked) is folded into the item that turn was about (foldReply); a resend of a
// message stopped moments ago updates the item the stop left (resendOf); and a waiting item
// the message speaks to is the agent's to act on again (wakeWaiting).
// `made`, when given, is filled with only the items it created (a resend or a reply touches
// one that was there before, and undoing the prompt must not delete it).
export function addPrompt(ledger, { text, at, turnId, source, queued, whole = false, choiceTurn = '', asked = '' }, ids = [], made = []) {
  if (isNudge(text)) return null
  const folded = !queued && choiceTurn ? foldReply(ledger, text, { at, choiceTurn, source, asked }) : null
  if (folded) { ids.push(folded.id); return folded.ledger }
  // A message that is not bare but still the next thing the person said after a numbered question
  // answers it too. Once, on the first of its asks: the rest of the message is more asks. Past a
  // paragraph it is a new brief that happens to come next, and an owner's decision never decays.
  let answers = !queued && choiceTurn && source === 'user' && requestText(text).length <= ANSWER_MAX ? asked : ''
  const asks = whole ? [requestItem(text)].filter(Boolean) : requestAsks(text)
  if (!asks.length) return null
  const prompt = (Number(ledger.prompt) || 0) + 1
  const window = queued && ledger.window ? ledger.window : prompt
  let next = { ...ledger, prompt, window }
  const inTurn = source === 'user'
  for (const ask of asks) {
    const again = resendOf(next, ask, { at, source })
    if (again) {
      next = {
        ...next,
        items: next.items.map(i => {
          if (i !== again) return i
          const { interrupted, interruptedAt, turnId: _t, queued: _q, inTurn: _m, ...rest } = i
          return {
            ...rest, text: ask, at, ...(turnId ? { turnId } : {}), ...(queued ? { queued: true } : {}), ...(inTurn ? { inTurn } : {}),
            prompt, resent: (Number(i.resent) || 0) + 1,
          }
        }),
      }
      ids.push(again.id)
      continue
    }
    // The same words again while the first copy is open: that item, handed to this turn as a
    // resend is (its `at` stays: the ask is as old as its first send).
    const same = repeatOf(next, ask, { at, source })
    if (same) {
      next = {
        ...next,
        items: next.items.map(i => {
          if (i !== same) return i
          const { interrupted, interruptedAt, turnId: _t, queued: _q, inTurn: _m, ...rest } = i
          return {
            ...rest, ...(turnId ? { turnId } : {}), ...(queued ? { queued: true } : {}), ...(inTurn ? { inTurn } : {}),
            prompt, repeated: (Number(i.repeated) || 0) + 1, repeatedAt: at,
          }
        }),
      }
      ids.push(same.id)
      continue
    }
    next = addItem(next, { text: ask, at, turnId, source, queued, prompt, asIs: true, inTurn, asked: answers })
    answers = ''
    ids.push(next.items[next.items.length - 1].id)
    made.push(next.items[next.items.length - 1].id)
  }
  return wakeWaiting(next, text, at) || next
}

// THE RESEND OF A STOPPED MESSAGE. The person sends, stops the turn (Esc), and sends the same
// words again, or the same words edited at the end, or extended, seconds later: one message to
// their mind, and it was two items. Measured on one lead's week: three such pairs, 3 to 13
// seconds apart, one identical, one sharing 154 of 159 characters, one the first message with
// a sentence added. `withdrawn` drops the rewound copy, but only at a gate, and only when the
// transcript holds one copy; most of the time both stayed open and both were judged. So a new
// ask within RESEND_MS of an interrupted, still-open item of the same source, whose words are
// the same or nearly (sameWords), IS that item.
export const RESEND_MS = 60_000
export function resendOf(ledger, ask, { at, source }) {
  const near = ledger.items.filter(i => i.state === 'open' && i.interrupted && i.source === source
    && Number(at) - (Number(i.interruptedAt) || Number(i.at) || 0) <= RESEND_MS && sameWords(i.text, ask))
  return near.length ? near[near.length - 1] : null
}
// THE SAME WORDS, SENT AGAIN. Measured over fourteen days of real ledgers in two profiles: 101
// items repeated an earlier item's exact text in the same session, 52 of them a lead's brief,
// in 43 sessions and up to 12 in one. 31 came within ten minutes of the first copy, and each
// was an item of its own: two rows on the band for one ask, each judged, and a proof that
// closed one left the other open. So a new ask whose normalized text EQUALS an open item of
// the same source, within REPEAT_MS of that item's last send, is that item: `repeated` counts
// the extra sends, `repeatedAt` is the last, and the item joins the new prompt's window.
// Exact text, not sameWords: an edited resend is a stopped message (resendOf), and a near
// match from a lead is as likely a second, different brief. Only an OPEN item: words that
// repeat a closed one are asking again. And only inside the window: 54 of the 101 came more
// than an hour apart, a new ask about the same thing, and those stay two items.
export const REPEAT_MS = 10 * 60_000
const normAsk = t => oneLine(t).toLowerCase().replace(/…/g, ' ').replace(/\s+/g, ' ').replace(/[\s.!?]+$/, '').trim()
export function repeatOf(ledger, ask, { at, source }) {
  const want = normAsk(ask)
  if (!want) return null
  const hit = ledger.items.filter(i => i.state === 'open' && i.source === source && normAsk(i.text) === want
    && Number(at) - (Number(i.repeatedAt) || Number(i.at) || 0) <= REPEAT_MS)
  return hit.length ? hit[hit.length - 1] : null
}

// Equal; one the start of the other; or sharing most of their opening; or most of their
// words. An item's text is an excerpt ("head… tail"), so the cut is set aside first.
export function sameWords(a, b) {
  const n = t => oneLine(t).toLowerCase().replace(/…/g, ' ').replace(/\s+/g, ' ').trim()
  const x = n(a), y = n(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.length >= 12 && long.startsWith(short)) return true
  let k = 0
  while (k < short.length && short[k] === long[k]) k++
  if (short.length >= 20 && k >= 0.8 * short.length) return true
  const wx = new Set(x.split(/\W+/).filter(Boolean)), wy = new Set(y.split(/\W+/).filter(Boolean))
  const shared = [...wx].filter(w => wy.has(w)).length
  return wx.size + wy.size > 0 && shared >= 4 && shared / new Set([...wx, ...wy]).size >= 0.8
}

// A BARE ANSWER TO THE AGENT'S OWN QUESTION. The agent ends a turn on "1. … 2. … which one?"
// and the person answers "2", "yes 1", "ok go with 2", a version number. Measured: eight such
// replies in one week, each its own item, each judged on its own and read as an ask with no
// subject. It is the item the question was about, answered: folded in as a reply (`replies`,
// which the judge is shown), and a waiting item is the agent's again. Only when the asking
// turn ended on a numbered choice (endsOnChoice, read where the turn is known) and only into
// an item that is still owed: one already closed leaves the reply to be an ask of its own.
const CHOICE_WORD = new Set('yes yeah yep y no n ok okay sure go do pick option opt the with both all none first second third one that this'.split(' '))
const CHOICE = /^(?:[#(]?\d+(?:\.\d+)*[).,]?|[a-e][).]?|both|all|none|first|second|third|yes|yeah|yep|y|no|n)$/
export function isBareChoice(text) {
  if (PASTE.test(String(text || ''))) { PASTE.lastIndex = 0; return false }
  PASTE.lastIndex = 0
  const t = requestText(text).toLowerCase().replace(/[.!]+$/, '')
  if (!t || t.length > 24) return false
  const words = t.split(/[\s,]+/).filter(Boolean)
  return words.length <= 4 && words.some(w => CHOICE.test(w)) && words.every(w => CHOICE.test(w) || CHOICE_WORD.has(w))
}
export function endsOnChoice(answer) {
  const tail = String(answer || '').slice(-800)
  return (tail.match(/^\s*\(?\d+[.)]\s+\S/gm) || []).length >= 2 && tail.includes('?')
}
const OWED = new Set(['open', 'waiting', 'stale'])
const ANSWER_MAX = 500
// The question a numbered choice put, as a reply will need it quoted: the options and the line that
// leads into them, because "2" says nothing without them. From the window endsOnChoice read.
export function askedIn(answer, n = 400) {
  const lines = String(answer || '').slice(-800).split('\n').map(l => l.trim()).filter(Boolean)
  const first = lines.findIndex(l => /^\(?\d+[.)]\s+\S/.test(l))
  if (first < 0) return ''
  return excerpt(lines.slice(Math.max(0, first - 1)).join(' '), n)
}
export function foldReply(ledger, text, { at, choiceTurn, source = '', asked = '' }) {
  if (!choiceTurn || !isBareChoice(text)) return null
  const of = ledger.items.filter(i => i.turnId === choiceTurn && OWED.has(i.state))
  const it = of.filter(i => i.source !== 'promise' && i.source !== QUESTION).pop() || of.filter(i => i.source !== QUESTION).pop()
  if (!it) return null
  const reply = { at, text: excerpt(requestText(text), 40), ...(source ? { source } : {}), ...(asked ? { asked } : {}) }
  const items = ledger.items.map(i => (i === it ? { ...reopened(i), replies: [...(i.replies || []).filter(r => r.at !== at), reply].slice(-3) } : i))
  return { id: it.id, ledger: { ...ledger, items } }
}

// A dormant item back to open, its closing fields cleared. A waiting item loses its progress
// note too: the person has moved, and the note said the move was theirs.
function reopened(i) {
  if (i.state === 'open') return i
  const { closedAt, closedBy, reason, keptOpen, ...rest } = i
  const { progress, ...bare } = rest
  return { ...(i.state === 'waiting' ? bare : rest), state: 'open' }
}

// The person speaks to a waiting item (their message mentions it): it is open again.
export function wakeWaiting(ledger, text, at) {
  const said = requestText(text)
  const woke = ledger.items.filter(i => i.state === 'waiting' && mentions(i.text, said, { loose: true }))
  if (!woke.length) return null
  return { ...ledger, items: ledger.items.map(i => (woke.includes(i) ? { ...reopened(i), woke: at } : i)) }
}

// A request submitted idle names its turn at that turn's start, which carries its text: every
// item of the newest message with those words that has no turn yet.
export function stampTurn(ledger, text, turnId) {
  const t = String(text || '').trim()
  if (!t) return null
  const asks = new Set([requestItem(t), ...requestAsks(t)])
  const fits = ledger.items.filter(x => x.state === 'open' && !x.turnId && x.source !== 'promise' && asks.has(x.text))
  if (!fits.length) return null
  // An item from before prompts were numbered has none: the first match, as it always was.
  const newest = Math.max(...fits.map(x => Number(x.prompt) || 0))
  const pick = new Set(newest ? fits.filter(x => Number(x.prompt) === newest).map(x => x.id) : [fits[0].id])
  return { ...ledger, items: ledger.items.map(x => (pick.has(x.id) ? { ...x, turnId } : x)) }
}

// `queued`: typed over a running turn. Such a message can still be pulled back out of the
// queue (Up edits it) and never reach the model; see `withdrawn` below.
// `prompt`: the message it came from (addPrompt). `asIs`: the text is already an item's.
export function addItem(ledger, { text, at, turnId, source, queued, prompt, by, asIs, inTurn, asked }) {
  const seq = (Number(ledger.seq) || 0) + 1
  const words = asIs ? String(text) : source === 'promise' ? excerpt(text) : requestItem(text)
  const item = {
    id: String(seq), text: words, at, ...(turnId ? { turnId } : {}), state: 'open', source,
    ...(queued ? { queued: true } : {}), ...(prompt ? { prompt } : {}), ...(by ? { addedBy: by } : {}),
    ...(inTurn ? { inTurn: true } : {}), ...(asked ? { asked } : {}),
  }
  return { ...ledger, seq, items: kept([...ledger.items, item]) }
}
// The ledger keeps its last KEEP_ITEMS items, and what waits on the person is never what goes:
// the oldest of the rest go first. A trim by position alone took the oldest for-you item with
// it, and that is the one the person has been asked longest.
function kept(items) {
  if (items.length <= KEEP_ITEMS) return items
  let over = items.length - KEEP_ITEMS
  const out = items.filter(i => (over > 0 && !heldOnPerson(i) ? (over--, false) : true))
  return out.length > KEEP_ITEMS ? out.slice(-KEEP_ITEMS) : out
}

const fresh = (i, nowMs) => nowMs - (Number(i.at) || 0) <= BAND_DAYS * DAY_MS
// Every open item, owed or not: what the judge reads and the gate picks from. Never a question
// to the person: that is for them to answer, not work the agent owes (see FOR YOU).
export const openItems = (ledger, nowMs) => ledger.items.filter(i => i.state === 'open' && i.source !== QUESTION && fresh(i, nowMs))

// A PERSON'S REQUEST IS OWED ONLY ONCE IT OUTLIVES ITS TURN. A plain instruction the session
// just carries out is not an open loop, and it was treated as one. Measured over fourteen days
// of real ledgers: of 1,607 items made from the person's own messages, 1,204 (75%) were closed
// before their next message. Each was still counted on the band ("ledger · 1 open"), listed in
// the note every prompt carries, and closed by the agent with `fleet-ledger close` from Bash:
// 3,305 such calls, each a main-model round trip of ~190 output tokens, for work the judge
// would have read as done at the turn's end anyway. The note was injected ~15,800 times.
//   So a `user` item is born `inTurn` (addPrompt) and, while the mark holds, is off the band
// and the record (ledgerSummary), the note (contextNote) and the held list (heldItems). The
// judge still reads it at its turn's end (openItems) and /ledger all still lists it. The end of
// the turn that answers it settles it (settleTurn): done or not-done closes it as always; any
// other verdict, a failed or skipped judge, or a stopped turn drops the mark, and from then on
// it is owed exactly as before, gate included. A mark nothing settled (a crash, a reload, a
// turn that never ended) stops counting after TURN_SCOPE_MS: it fails OPEN, never shut.
export const TURN_SCOPE_MS = 30 * 60_000
export const owed = (i, nowMs) => !i.inTurn || nowMs - (Number(i.at) || 0) >= TURN_SCOPE_MS
const owedItems = (ledger, nowMs) => openItems(ledger, nowMs).filter(i => owed(i, nowMs))

// The marks the end of turn `turnId` settles. `startedAt`: when it started (0 when not known,
// a reload mid-turn: every mark settles, failing open). `movedOn`: a turn has started since
// this one ended.
//   A message typed over a running turn carries THAT turn's id (`queued`). When a turn started
// since, the message is what started it, and it is answered there: its mark waits for that
// turn's end. When none did, the turn folded the message in, and it settles here.
//   Any other mark from before this turn started settles here, so a turn whose own end was
// never judged (a judge busy with an older turn, a reload) leaves nothing marked behind it.
// One made after it started belongs to a turn that has not ended yet.
export function settleTurn(ledger, { turnId, startedAt = 0, movedOn = false }) {
  const due = i => i.inTurn && (i.queued && i.turnId === turnId ? !movedOn : !startedAt || (Number(i.at) || 0) <= startedAt)
  if (!ledger.items.some(due)) return null
  return { ...ledger, items: ledger.items.map(i => { if (!due(i)) return i; const { inTurn, ...rest } = i; return rest }) }
}

// Did the agent close an item of its own in this turn? `closedTurn` says so for the tools,
// which run inside the mod and know the turn. `fleet-ledger close` runs from Bash, outside it,
// and writes no turn: measured, 3,305 closes that way in fourteen days against none through
// the tools, so the turn's own closes were never seen and the judge was called on turns it
// was built to skip. A close with no turn on it counts by its time: at or after the turn began.
export function closedInTurn(ledger, { turnId, startedAt = 0 }) {
  return ledger.items.some(i => i.closedBy === 'agent'
    && (i.closedTurn ? i.closedTurn === turnId : startedAt > 0 && (Number(i.closedAt) || 0) >= startedAt))
}

// What the record and the band say: open requests, open promises, the oldest open of each,
// owed ones only (see owed); and, apart from them, what is for the person (forYouItems).
export function ledgerSummary(ledger, nowMs) {
  const open = owedItems(ledger, nowMs)
  const req = open.filter(i => i.source !== 'promise')
  const prom = open.filter(i => i.source === 'promise')
  const yours = forYouItems(ledger, nowMs)
  const oldest = list => list.length ? { id: list[0].id, text: excerpt(list[0].text, 80), at: list[0].at } : null
  // A failure is shown while something is open: with nothing open it has cost nothing, and
  // a hand-cleared ledger would otherwise go on saying so until the next judged turn.
  const j = req.length || prom.length ? ledger.judge : null
  return {
    open: req.length, promises: prom.length, oldest: oldest(req), oldestPromise: oldest(prom),
    forYou: yours.length, oldestForYou: oldest(yours),
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
// `forPerson`: what is already open for the person, so a line the turn asks of them again is named
// (`same`) rather than added twice. `relist`: a waiting-on-you list held for pairing (captureForYou),
// { items: [{ text }], old: [{ id, text }] }.
export function judgePrompt(items, turn, { promises, earlier = [], openPromises = [], forPerson = [], relist = null }) {
  const blocks = typeof turn === 'string' ? [turn] : turn || []
  const tail = turnText(blocks, ANSWER_CHARS)
  const final = blocks.length > 1 ? `the LAST block (${blocks.length} of ${blocks.length})` : 'the message'
  const before = earlier.slice(-2).map(t => turnText(t, EARLIER_CHARS))
  const list = items.length
    ? items.map(i => `${i.id} [${i.source === 'promise' ? 'promise the agent made' : 'request to the agent'}]: ${excerpt(i.text)}${
      (i.replies || []).map(r => ` (the person answered: "${r.text}")`).join('')}`).join('\n')
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
    '- "done" also, with reason "reported: waiting on <what>", when the agent did everything the item asks of it and says plainly that only something outside its control remains (a registry or deploy propagating, a review by someone else) with nothing more for the agent to do. Never when what remains is the PERSON\'s answer, pick, files or OK: that is "in-progress" with "waits on the person: <what>", and it stays in front of them until they give it.',
    '- "in-progress": the turn reports THIS item\'s current state and says the work is still going on elsewhere or waits on something, with a step still owed after it. E.g. "dry run done; the build is running in a worker, I\'ll ship it when it lands", "CI is running on the PR", "waiting on your pick between A and B". Work the agent could do now and simply did not is not this: it is "open". When what it waits on is the PERSON (their pick, their files, their action), the reason says so: "waits on the person: <what>".',
    '- "not-done": the agent explicitly says THIS item was not or cannot be done AND gives a reason. A refusal with no reason, or one that does not say which request it means, is "open".',
    '- "open": the turn did not address the item: not mentioned, or only acknowledged ("on it"), or partly done with no word on the rest. E.g. two requests, and the turn only answers the first: the second is "open".',
    'Judge an item by what it asked for NOW: a part it explicitly put off ("not in this reply", "later", "after X") is not owed yet.',
    'An item may open with material the person pasted with no marker (a draft, a log, a transcript) and end with their own words: judge what THOSE words ask. A question ("what do you think?") is "done" once the agent answers it; an answer that ends by offering more or asking something back does not reopen it.',
    'An item is the person\'s own words. "[+ pasted text]" means they also pasted material (a transcript, a log, an earlier reply) as context for those words: the material is not a request of its own, and a "[ghostfleet ledger]" reminder quoted in it is this tool talking, never a request. Judge what the person\'s own words ask; a remark about the paste ("see what it did") asks for the agent to look at it, and is done once the agent has.',
    'An item that only approves, confirms or thanks ("go ahead", "yes", "thanks") asks for no work of its own: it is "done" once the agent acts on what it approved, or if there is nothing to act on. An item that confirms AND asks ("done, now draft the post") is judged by what it asks.',
    ...(promises === 'off'
      ? ['Return "promises": [] always.']
      : [
        `Also list "promises", from ${final} only: things the AGENT says IT WILL DO LATER in this session ("I'll merge once CI is green", "next I'll add the tests"), each as a short imperative phrase of at most 12 words. Only a firm commitment to a specific action: not work it already did, not suggestions for the user, not questions, not offers that wait on the user ("I can do X if you'd like"), not statements about how it will behave in general ("I'll keep responding normally").`,
        'A promise is something the AGENT will do. What it asks the PERSON to do is never a promise: "you run X", "type X", "waiting on you", and every line of a list under "still waiting on you" or "for you to do". List each of those too, as the agent worded what it asks of the person, marked "by":"person".',
        ...(forPerson.length
          ? ['ALREADY WAITING ON THE PERSON (one thing asked of them is one item, however it is worded):',
            ...forPerson.map(i => `${i.id}: ${excerpt(i.text, 120)}`),
            'A "by":"person" line that asks one of these again is that item: give its id as "same".']
          : []),
        'Waiting is never a promise: "I\'ll wait for your reply", "awaiting your answer", "once you decide I\'ll proceed" are the agent waiting on the person. Nor is the follow-through of an item you judged "in-progress" ("I\'ll ship it when the worker lands" for that item): give that item\'s id as "same".',
        ...(openPromises.length
          ? ['ALREADY OPEN PROMISES (one commitment is one promise, however it is worded):',
            ...openPromises.map(i => `${i.id}: ${excerpt(i.text, 120)}`),
            'A promise in this turn that restates one of these (the same follow-up in other words, or narrower or wider) is that promise: give its id as "same". Only a different commitment has "same":"".']
          : []),
        '[] if none.',
      ]),
    '',
    'Also say "waitingOnPerson": true when the turn ENDS by asking the person a question or waiting on their decision or action ("which do you want?", "pick one of A, B, C", "tell me when it is deployed"); false otherwise, and false for an answer that merely closes with an offer ("want me to do more?").',
    ...(relist && relist.items.length && relist.old.length
      ? ['',
        'THE AGENT LISTED AGAIN WHAT WAITS ON THE PERSON. These lines of its newest list match nothing still open word for word:',
        ...relist.items.map((a, k) => `N${k + 1}: ${excerpt(a.text, 160)}`),
        'Still open from its earlier lists:',
        ...relist.old.map(i => `${i.id}: ${excerpt(i.text, 160)}`),
        'Pair each N line with the earlier item it restates (the same thing asked of the person, in other words) in "relisted". A line that asks something different is left unpaired; [] if none.']
      : []),
    '',
    'Reply with ONLY this JSON, no prose, no code fence:',
    `{"items":[{"id":"<id>","status":"done|in-progress|not-done|open","reason":"<at most 12 words>"}],"waitingOnPerson":false,"promises":[${promises === 'off' ? '' : '{"text":"<at most 12 words>","by":"agent|person","same":"<open promise, in-progress item or waiting-on-the-person id, or empty>"}'}]${
      relist && relist.items.length && relist.old.length ? ',"relisted":[{"new":"N1","old":"<id>"}]' : ''}}`,
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
const STATUSES = ['done', 'in-progress', 'not-done', 'open']
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
    v = { items: found, promises, waitingOnPerson: /"waitingOnPerson"\s*:\s*true/.test(s) }
    partial = true
  }
  const known = new Set(ids)
  const items = []
  for (const it of v.items) {
    if (!it || !known.has(String(it.id))) continue
    const status = String(it.status || '')
    if (!STATUSES.includes(status)) continue
    items.push({ id: String(it.id), status, reason: excerpt(it.reason, 120) })
  }
  if (partial && !items.length) return null
  // Each promise as { text, same? }: a plain string (the shape before `same`) is a new one, and
  // one the judge says is the PERSON's to do is not a promise at all: it is what the turn asks of
  // them (`forPerson`, FOR YOU), unless it is only the agent waiting for their reply.
  const said = (Array.isArray(v.promises) ? v.promises : []).map(p => (p && typeof p === 'object' ? p : { text: p }))
  const theirs = p => String(p.by || 'agent').toLowerCase() === 'person'
  const promises = said.filter(p => !theirs(p))
    .map(p => ({ text: excerpt(p.text, 120), ...(p.same ? { same: String(p.same) } : {}) }))
    .filter(p => p.text && !addressedToPerson(p.text) && !waitsOnPerson(p.text)).slice(0, 3)
  const forPerson = said.filter(theirs)
    .map(p => ({ text: excerpt(p.text, 160), ...(p.same ? { same: String(p.same) } : {}) }))
    .filter(p => p.text && !waitsOnPerson(p.text)).slice(0, 8)
  const relisted = (Array.isArray(v.relisted) ? v.relisted : []).filter(p => p && typeof p === 'object')
    .map(p => ({ new: String(p.new ?? ''), old: String(p.old ?? '') })).filter(p => p.new && p.old)
  return { items, promises, forPerson, relisted, waitingOnPerson: v.waitingOnPerson === true, ...(partial ? { partial: true } : {}) }
}

// The judge asks about at most JUDGE_BATCH items per call, the newest first. One verdict is
// one {"id","status","reason"} object per item. Measured on haiku: 46 items in one call took
// 1,737 output tokens (38 an item) against the 700 the call allowed, so it was cut off.
// Batches of ten took 325-343, and the first batch, the one that also reads promises, 589:
// 84% of 700, too close. So ten a call, and 1,500 tokens each, over twice the worst measured.
// The budget is a ceiling, not a cost: a call is billed for what it writes.
export const JUDGE_BATCH = 10
export const JUDGE_TOKENS = 1500
export function judgeBatches(items, n = JUDGE_BATCH) {
  const newest = [...items].sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0) || Number(y.id) - Number(x.id))
  const out = []
  for (let k = 0; k < newest.length; k += n) out.push(newest.slice(k, k + n))
  return out
}

// WHAT THE JUDGE COSTS, KEPT AS IT GOES. `judge` holds the last judged turn and nothing else,
// so a fleet's judge spend could not be counted at all: every turn wrote over the one before.
// `judged` adds each turn's calls to running totals in the same file: turns judged, model
// calls, calls that failed open, items judged, and tokens, counted only from calls whose
// result reported `usage` (`reported`), so a host that reports none reads as "not reported"
// rather than as a free judge. Counts only: no text, no item ids. `since` is the first turn
// counted; a ledger from before this field starts at zero, never at a guess.
export function countJudge(totals, { at, calls = 0, failedCalls = 0, items = 0, usage = [] }) {
  const t = totals && typeof totals === 'object' ? totals : {}
  const n = v => Number(v) || 0
  const rep = usage.filter(u => u && typeof u === 'object')
  return {
    since: n(t.since) || at,
    at,
    turns: n(t.turns) + 1,
    calls: n(t.calls) + calls,
    failedCalls: n(t.failedCalls) + failedCalls,
    items: n(t.items) + items,
    reported: n(t.reported) + rep.length,
    inputTokens: n(t.inputTokens) + rep.reduce((k, u) => k + n(u.input_tokens), 0),
    outputTokens: n(t.outputTokens) + rep.reduce((k, u) => k + n(u.output_tokens), 0),
  }
}

// A promise is not gated by default, it is only shown, and one no turn ever addresses would
// stay on the band for the full BAND_DAYS. So a promise the judge was shown and kept open in
// STALE_TURNS judged turns closes as `stale`. Five: a "once CI is green" spans a turn or two
// of other work; five turns that never mention it is a commitment the session has dropped.
export const STALE_TURNS = 5

// One commitment is one promise. Measured live: four open promises were one follow-up in
// four phrasings, added on three consecutive turns ("read the ledgers after the next turns",
// "watch for re-prompt closure in acme-api and acme-web", "check acme-api, acme-web, toolbox
// ledgers after next turns", "read acme-api, acme-web, toolbox ledgers ..."): the judge was
// never told which promises were open, kept the old one open (correctly) and extracted the
// same commitment again in new words, and the only check was exact text. The judge now sees
// the open promises and names the one a phrase restates (`same`); this is the backstop for
// when it does not. Two phrasings are one promise when they share at least two content
// words and those are at least SAME_SHARE of the shorter one's. Verbs of looking are one
// verb, and a plural is its singular. On the four above, any two linked through a third:
// the first and second share only the verb (1 of 4). So a promise keeps the phrasings folded
// into it (`said`, the last SAID_KEPT) and a new one is matched against all of them; and when
// a new phrasing matches two open promises, they were one all along and fold into the older.
export const SAME_SHARE = 0.6
const SAID_KEPT = 4
const STOP = new Set('a an the to of in on at for and or then once when after before with by from it its is be this that these those any all i ill will we me my our up out as so just again'.split(' '))
const LOOK = new Set(['read', 'check', 'watch', 'look', 'review', 'verify', 'inspect', 'monitor', 'confirm', 'see'])
export function promiseWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9.\-/]+/)
    .map(w => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter(w => w && !STOP.has(w))
    .map(w => (LOOK.has(w) ? 'check' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))
}
export function samePromise(a, b) {
  const x = promiseWords(a), y = promiseWords(b)
  const shared = [...x].filter(w => y.has(w)).length
  return shared >= 2 && shared / Math.min(x.size, y.size) >= SAME_SHARE
}

// What the agent asks the PERSON to do is not its promise. Measured live: "Run npm login &&
// npm publish" and "Type /reload-plugins between turns" became promises, read off a closing
// "Still waiting on you:" list. The prompt says so; this catches a phrase that names the
// person outright.
export const addressedToPerson = text => /\b(you|your|yourself)\b/i.test(String(text || ''))

// Waiting on the person is not a promise either: "wait for the user's reply" kept on the band
// as something the agent owes is the person's move dressed as the agent's, and it would stay
// open until it went stale. The prompt says so; this catches the phrasings that name no
// "you" for the test above to find ("await the user's answer", "once they decide").
const WAITS = /\b(wait(?:ing)?|await(?:ing)?|hear(?:ing)? back|stand(?:ing)? by)\b(?:(?![.;]).)*\b(user|person|owner|reply|replies|answer|answers|decision|decides?|response|confirm\w*|go-?ahead|approv\w*|input|pick|choice)\b/i
const UPON = /^(once|when|after|if|until) (the )?(user|person|owner|they) (decides?|repl(y|ies)|answers?|confirms?|picks?|chooses?|approves?|responds?)\b/i
export const waitsOnPerson = text => WAITS.test(String(text || '')) || UPON.test(String(text || '').trim())

// At most PROMISE_CAP open promises: a new one past it stales the oldest. Promises are shown,
// not gated, and five is already more than a band row or a person can keep in view.
export const PROMISE_CAP = 5

// A BRIEF FROM THE LEAD IS DONE ONLY WITH PROOF. The judge reads a turn's prose and never its
// work, so "done" from it is a reading of what the agent said. For the person's own messages
// and the agent's promises that reading is the backup it was built to be. For a `fleet` item
// it was the fleet's record of work: measured on one fleet, 670 of 1,676 closed items (40%)
// were closed by the judge with no proof, and in one weekend stretch all 33 "done" items
// across 23 workers were, while the lead's own transcript shows nothing merged or spawned in
// that time. It read as days of autonomous work that did not happen. So a fleet item the
// judge reads as done stays OPEN with `answered` on it, and the gate asks the agent once for
// the proof (proofTargets); ledger_close with proof, or the person by hand, closes it. The
// judge may still keep it open, report it in progress, or hold it waiting. Not retroactive:
// an item the judge closed before this keeps its state. An item carried to a lead from a
// stopped worker is `fleet` too, and needs proof the same way (proofTargets says why it is
// never nudged for it).
export const needsProof = i => i.source === 'fleet'
function answeredOnly(i, v, nowMs, turnId) {
  const { progress, ...rest } = i
  return { ...rest, answered: { at: nowMs, ...(turnId ? { turnId } : {}), ...(v.reason ? { reason: v.reason } : {}) } }
}

// The verdict applied: judged items close, promises join as items of their own. A promise
// the judge says restates an open one (`same`), or that reads as one (samePromise), is that
// promise, never a second; its newer words replace the older ones only when the judge said so.
// An item judged in-progress stays open and carries `progress`, which the gate reads: it is
// being worked, and naming it again only gets the same report back. A promise whose words
// are the follow-through of such an item ("ship it when the worker lands") is that item.
// `relist`: this call was shown the turn's held list (the first batch); `forPerson`: the turn was
// the person's, not a lead's brief, whose asks are the lead's to answer.
export function applyVerdict(ledger, verdict, { nowMs, turnId, promises, relist = false, forPerson = true }) {
  const by = new Map(verdict.items.map(i => [i.id, i]))
  let next = {
    ...ledger,
    items: ledger.items.map(i => {
      const v = by.get(i.id)
      if (!v) return i
      if (DORMANT.has(i.state)) return revisited(i, v, nowMs, turnId)
      if (i.state !== 'open') return i
      // Not a turn that ignored it: its count towards going stale starts again. Measured: a
      // promise reported on ("#12 merged; #13 awaiting") went stale five turns later on the
      // count it had before the report, and from stale nothing could close it.
      if (v.status === 'in-progress') {
        const { keptOpen, answered, ...rest } = i
        const progress = { at: nowMs, ...(turnId ? { turnId } : {}), ...(v.reason ? { reason: v.reason } : {}) }
        return waitsOnPersonNote(v.reason) ? { ...rest, state: 'waiting', progress } : { ...rest, progress }
      }
      if (v.status === 'open') {
        if (i.source !== 'promise') return i
        const kept = (Number(i.keptOpen) || 0) + 1
        return kept < STALE_TURNS ? { ...i, keptOpen: kept }
          : { ...i, keptOpen: kept, state: 'stale', closedAt: nowMs, closedBy: 'judge', reason: `no turn addressed it in ${kept} judged turns` }
      }
      if (v.status === 'done' && waitsOnPersonNote(v.reason)) return heldForPerson(i, v, nowMs, turnId)
      if (v.status === 'done' && needsProof(i)) return answeredOnly(i, v, nowMs, turnId)
      return { ...i, state: v.status, closedAt: nowMs, closedBy: 'judge', ...(v.reason ? { reason: v.reason } : {}) }
    }),
  }
  // The judge's half of FOR YOU (captureForYou): the list it was shown to pair, then what it read
  // as asked of the person, then each held request's step, which may be one of those.
  if (relist && next.relist && next.relist.turnId === turnId) next = resolveRelist(next, verdict.relisted, { at: nowMs })
  if (forPerson && promises !== 'off') next = personAsks(next, verdict.forPerson, { at: nowMs, turnId })
  next = linkSteps(next, turnId, nowMs)
  if (promises === 'off') return next
  const openP = () => next.items.filter(i => i.source === 'promise' && i.state === 'open')
  const close = (ids, reason) => {
    next = { ...next, items: next.items.map(i => (ids.includes(i.id) ? { ...i, state: 'stale', closedAt: nowMs, closedBy: 'judge', reason } : i)) }
  }
  const working = next.items.filter(i => i.state === 'open' && i.source !== 'promise' && i.progress)
  for (const p of verdict.promises) {
    if (p.same && working.some(i => i.id === p.same)) continue
    if (working.some(i => samePromise(i.text, p.text))) continue
    const named = p.same && openP().find(i => i.id === p.same)
    if (named) {
      next = { ...next, items: next.items.map(i => (i === named ? { ...i, text: excerpt(p.text) } : i)) }
      continue
    }
    const said = i => [i.text, ...(i.said || [])]
    const like = openP().filter(i => said(i).some(t => t.toLowerCase() === p.text.toLowerCase() || samePromise(t, p.text)))
    if (like.length) {
      // The oldest keeps the commitment, and every phrasing of it; the others it bridges were
      // the same one all along.
      const keep = like[0]
      const words = [...new Set([...(keep.said || []), ...like.slice(1).flatMap(said), p.text])].filter(t => t !== keep.text).slice(-SAID_KEPT)
      next = { ...next, items: next.items.map(i => (i.id === keep.id ? { ...i, said: words } : i)) }
      if (like.length > 1) close(like.slice(1).map(i => i.id), `same as promise ${keep.id}`)
      continue
    }
    next = addItem(next, { text: p.text, at: nowMs, turnId, source: 'promise', prompt: Number(next.prompt) || 0 })
  }
  const over = openP().length - PROMISE_CAP
  if (over > 0) close(openP().slice(0, over).map(i => i.id), `over the cap of ${PROMISE_CAP} open promises`)
  return next
}

// DORMANT ITEMS STAY JUDGEABLE. `stale` was a dead end: the judge reads only open items, so a
// promise that went stale was never judged again, and work that visibly finished later left it
// stale for good. Measured on one lead's week: 23 stale promises, among them a "merge and
// deploy #12 and #13 when CI passes" whose last note was "#12 merged; #13 awaiting", with both
// merged a few turns on. Twenty of the 23 had gone stale over PROMISE_CAP, not over a count of
// turns. So a stale or waiting item a turn MENTIONS (mentions) is shown to the judge with the
// open ones, at most JUDGE_BATCH of them, newest first; one nobody mentions costs nothing.
// A stale item untouched for EXPIRE_DAYS is retired (expireDormant): `expired`, never open,
// never revisited.
//
// A WAITING ITEM EXPIRED TOO, after WAITING_EXPIRE_MS untouched; today only one the person does
// not hold up does (a lead's brief held on its sender: see FOR YOU, heldOnPerson). It was the person's and waited
// as long as the band kept it, a week, and the person's queue filled with what they had already
// moved past. Measured: of 35 waiting items within 7 days, 34 were over a day old and 27 had
// three or more messages from the person since, among them a question a later PR had settled,
// "open the app to load the new version", and promises tied to a clock time long gone. They
// stayed because a reply like "1 a" or "yes" shares too few words to wake one (mentions). One
// day: a question put to the person at night is still in front of them the next morning, and
// one they have not answered in a day of talking to the session is one they have moved past.
// Off heldItems (the phone's queue, the status note) the moment it is a day old, and written
// as `expired` at the next judged turn; still in `/ledger all`, still closable. That retired
// decisions nobody had made: a question unanswered for a day is not a question answered, and
// the person's queue cannot drop what they were asked. So what is for the person stays until
// they answer it (by number now, answerRefs) or drop it, and the queue shows each with its own
// answer controls instead of a day's worth of guesses. And a turn the
// person's own message started shows the judge their waiting items, word match or not
// (revisitTurn), so the reply the words could not tie to its item still closes it.
//
// WAITING ON THE PERSON. A turn that reports an item in progress because it waits on the
// person ("the assembly waits on the user taking the screenshots") left it open, listed, in the prompt's
// note, and named in reminders the agent could only answer with the same report. Such an item
// is `waiting`: off every open count and the gate, until the person's message mentions it
// (wakeWaiting) or answers the question about it (foldReply).
export const DORMANT = new Set(['stale', 'waiting'])
export const EXPIRE_DAYS = 3
export const WAITING_EXPIRE_MS = 24 * 3_600_000
const PERSON = String.raw`(?:you\b|your\b|the\s+(?:user|person|owner|human)\b|(?:user|person|owner|human)\b)`
const WAITS_NOTE = [
  new RegExp(String.raw`\b(?:wait(?:s|ing|ed)?|await(?:s|ing|ed)?|blocked|depend(?:s|ing|ent)?|pending)\s+(?:on|for|upon)\s+${PERSON}`, 'i'),
  new RegExp(String.raw`\bawait(?:s|ing)?\s+${PERSON}`, 'i'),
  /\b(?:the\s+)?(?:user|person|owner)\s+(?:must|has to|needs to)\b/i,
]
export const waitsOnPersonNote = reason => WAITS_NOTE.some(re => re.test(String(reason || '')))

// Does `text` speak to the item? Content words, with plural and tense set aside ("merged" is
// "merge"). Loose (the person's own message): two shared words. Strict (a whole turn, which
// shares two words with nearly anything): a shared number such as a PR's, or half the item.
const stem = w => (w.length > 4 ? w.replace(/(?:ing|ed|es|e|s)$/, '') : w)
const mentionWords = t => new Set([...promiseWords(t)].map(stem).filter(w => w.length >= 2))
export function mentions(itemText, text, { loose = false } = {}) {
  const x = mentionWords(itemText)
  if (!x.size) return false
  const y = mentionWords(text)
  const shared = [...x].filter(w => y.has(w))
  if (shared.length < 2) return false
  return loose || shared.some(w => /\d/.test(w)) || shared.length >= 0.5 * x.size
}
const lastTouch = i => {
  const t = [i.at, i.progress && i.progress.at, i.woke].filter(x => typeof x === 'number')
  return t.length ? Math.max(...t) : 0
}
const waitedOut = (i, nowMs) => i.state === 'waiting' && !heldOnPerson(i) && nowMs - lastTouch(i) > WAITING_EXPIRE_MS
const pastDue = (i, nowMs) => (i.state === 'stale' && nowMs - lastTouch(i) > EXPIRE_DAYS * DAY_MS) || waitedOut(i, nowMs)
export function revisit(ledger, nowMs, text, n = JUDGE_BATCH) {
  const t = String(text || '')
  if (!t.trim()) return []
  return ledger.items.filter(i => DORMANT.has(i.state) && fresh(i, nowMs) && !pastDue(i, nowMs) && mentions(i.text, t))
    .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, n)
}
// What a turn's judge is shown beside the open items: the dormant ones its text mentions
// (revisit), and on a turn the PERSON's own message started (`person`: typed, or delivered as
// the owner's, never a nudge, a gate's re-prompt or a lead's brief) every waiting item not past
// due (one waiting on the person never is; one waiting on anyone else is after a day), newest
// first, at most JUDGE_BATCH, mentioned or not. The person moved; the
// judge reads whether the turn did what they waited for (done closes it, in progress reopens
// it: revisited), and one it did not address stays waiting.
export function revisitTurn(ledger, nowMs, text, { person = false } = {}) {
  const back = revisit(ledger, nowMs, text)
  if (!person) return back
  const waiting = ledger.items.filter(i => i.state === 'waiting' && fresh(i, nowMs) && !pastDue(i, nowMs) && !back.includes(i))
    .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, JUDGE_BATCH)
  return [...back, ...waiting]
}
export function expireDormant(ledger, nowMs) {
  const old = ledger.items.filter(i => pastDue(i, nowMs))
  if (!old.length) return null
  const why = i => (i.state === 'waiting' ? `waiting on the person, untouched for ${WAITING_EXPIRE_MS / 3_600_000} hours` : `stale, untouched for ${EXPIRE_DAYS} days`)
  return {
    ...ledger,
    items: ledger.items.map(i => (old.includes(i) ? { ...i, state: 'expired', expiredAt: nowMs, reason: why(i) } : i)),
  }
}
// A verdict on a dormant item: done and not-done close it; in progress reopens it, or keeps it
// waiting when what it waits on is still the person; "open" leaves it where it was.
function revisited(i, v, nowMs, turnId) {
  if (v.status === 'done' && waitsOnPersonNote(v.reason)) return heldForPerson(i, v, nowMs, turnId)
  if (v.status === 'done' && needsProof(i)) return answeredOnly(reopened(i), v, nowMs, turnId)
  if (v.status === 'done' || v.status === 'not-done') return { ...i, state: v.status, closedAt: nowMs, closedBy: 'judge', ...(v.reason ? { reason: v.reason } : {}) }
  if (v.status !== 'in-progress') return i
  const progress = { at: nowMs, ...(turnId ? { turnId } : {}), ...(v.reason ? { reason: v.reason } : {}) }
  return waitsOnPersonNote(v.reason) ? { ...i, state: 'waiting', progress } : { ...reopened(i), progress }
}

// A "done" whose reason is that it waits on the person is not done: the missing piece is their
// answer, and closing it took the question out of their sight. It is held for them (waiting),
// with what the judge said it waits on as its note.
function heldForPerson(i, v, nowMs, turnId) {
  const { closedAt, closedBy, reason, keptOpen, answered, ...rest } = i
  return { ...rest, state: 'waiting', progress: { at: nowMs, ...(turnId ? { turnId } : {}), reason: v.reason } }
}

// ── FOR YOU: what waits on the person, kept apart from what the agent owes ────────
//
// ONE LEDGER, TWO DIRECTIONS. The ledger kept what the person asked and what the agent
// promised, and what the agent asked the PERSON had no place of its own: at best a request the
// judge read as "in progress, waits on the person" (waiting), counted nowhere and retired a day
// later; at worst "done, reported: waiting on your pick", closed. Measured on one lead: a turn
// ended on 20 numbered questions to the owner while its band read "3 open", and those three were
// the agent's own work. So every item has a direction:
//   owed by the agent  the person's asks, a lead's briefs, the agent's promises: the band's
//                      "N open", the note, the judge and the gate, exactly as before. One the
//                      judge holds `waiting` on the person is STILL owed: blocked, not handed over
//   for you            forYou(): an open `question`, the one source of what is asked OF the
//                      person: a numbered question, a line of a waiting-on-you list, a closing
//                      choice, what the judge read as asked of them, and the step an owed item
//                      waits on (linkSteps). The band's "M for you", the phone's list and the
//                      briefing's WAITING ON THE OWNER all read this one rule (forYouItems,
//                      ledgerChanges)
// A held request was for-you too, until the owner's queue filled with the agent's own work: "merge
// the PR once you have looked" is the person's ask echoed back, and what they had to DO about it
// ("your OK on #31") was nowhere on its card. So the request stays in the agent's list, waiting,
// and what it waits on is a for-you item of its own that it `awaits`: answered, it hands the
// request back (wakeAwaiting). A file from before reads the same way; nothing is deleted.
// A for-you item never expires, is never handed to the judge as work the agent owes, and leaves
// when the person answers it (settleQuestions, answerItem), when the agent closes it with their
// answer, when it is dropped, or when the agent's newest waiting-on-you list no longer carries it
// (captureForYou). NOT A `fleet` ITEM: a prompt one session sent another is owed to the sender,
// and it is the sender's to answer, never the owner's. NOR A PROMISE: that is the agent's own word.
export const QUESTION = 'question'
export function forYou(i) {
  return Boolean(i) && i.source === QUESTION && i.state === 'open'
}
// Held for questions of the person's still open (awaitsHeld keeps only those): not counted for
// them a second time, but still waiting on their answer, so neither the day's expiry nor the
// trim may take it. Taking it left the question with nothing to hand back when it was answered.
const awaiting = i => Boolean(i) && i.state === 'waiting' && Array.isArray(i.awaits) && i.awaits.length > 0
// What the person holds up, whose day of waiting never runs out and whom the file's trim never
// takes: a for-you item, a request held for one, and a request the judge held waiting on the
// person before any step said what to do (a file from before, or one whose step closed some way
// other than their answer). That last is the agent's still (see FOR YOU), but it is blocked on
// them, and retiring it after a day would close work nobody had unblocked.
export const heldOnPerson = i => forYou(i) || awaiting(i) || (i.state === 'waiting' && owes(i))
// ONE DECISION, ONE ITEM. A turn that ends on its questions, about a request the judge then holds
// for the person, is one thing for them to answer, not two: the request `awaits` those questions
// and is not listed itself while any is open, and the questions answered hand it back to the
// session (wakeAwaiting). A request whose questions all closed some other way (dropped, closed by
// the agent) is listed again on read, so nothing waits on the person unseen.
function awaitsHeld(items) {
  if (!items.some(i => Array.isArray(i.awaits))) return items
  const open = new Set(items.filter(i => i.source === QUESTION && i.state === 'open').map(i => i.id))
  return items.map(i => {
    if (!Array.isArray(i.awaits)) return i
    const left = i.awaits.filter(id => open.has(String(id)))
    if (left.length === i.awaits.length) return i
    const { awaits, ...rest } = i
    return left.length ? { ...rest, awaits: left } : rest
  })
}
// WHAT THE PERSON MUST DO, ITS OWN ITEM. Each owed request the judge held waiting on the person in
// turn `turnId` awaits the for-you items that say what it waits on: the open ones it names (sameAsk,
// against its text and the judge's note), else every one that turn asked (a turn that ends on its
// questions about the request is one decision for the person, not two), else a STEP made from the
// judge's note, so the person sees what to do and never the request itself. A lead's brief is not
// held on the owner (see FOR YOU), and a promise is the agent's own word: neither gets one.
const owes = i => i.source !== 'fleet' && i.source !== 'promise' && i.source !== QUESTION
export function linkSteps(ledger, turnId, nowMs) {
  if (!turnId) return ledger
  const held = ledger.items.filter(i => i.state === 'waiting' && owes(i) && i.progress && i.progress.turnId === turnId && !awaiting(i))
  let next = ledger
  for (const h of held) next = stepFor(next, h, { turnId, at: nowMs })
  return next
}
function stepFor(ledger, h, { turnId, at }) {
  const open = ledger.items.filter(forYou)
  const note = personNote(h.progress && h.progress.reason)
  const named = open.filter(q => sameAsk(q.text, `${h.text} ${note}`) || (note && sameAsk(q.text, note)))
  const mine = turnId ? open.filter(q => q.turnId === turnId) : []
  let ids = (named.length ? named : mine).map(q => q.id)
  let next = ledger
  if (!ids.length) {
    if (!note) return ledger
    // As old as the wait it names: a request held a day has asked the person for a day.
    next = addAsk(next, { text: excerpt(note), via: 'step' }, { at: Number(h.progress && h.progress.at) || at, turnId }, ids)
  }
  return { ...next, items: next.items.map(i => (i.id === h.id ? { ...i, awaits: ids } : i)) }
}
// The judge's note, as the person's to-do: "waits on the person: their pick of region" is "Your
// pick of region". Only the framing changes; what it names is the judge's reading of the turn.
function personNote(reason) {
  let t = oneLine(reason)
    .replace(/^(?:reported:\s*)?(?:it\s+|still\s+)*(?:waits?|waiting|awaits?|awaiting|blocked|depends?|depending|pending)\s+(?:on|for|upon)\s+(?:you|the\s+(?:user|person|owner|human)|(?:user|person|owner|human))(?:'s)?\s*[:,;—–-]?\s*/i, '')
    .replace(/^(?:the\s+)?(?:user|person|owner)\s+(?:must|has to|needs to)\s+/i, '')
    .replace(/^to\s+/i, '')
  t = t.replace(/\btheir\b/gi, 'your').replace(/\bthe (?:user|person|owner)'s\b/gi, 'your').replace(/\bthey\b/gi, 'you')
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}
// A step whose request moved on (closed, woken by the person's own message, answered by hand)
// asks for nothing any more, and left open it would be the person's to clear. It closes at the
// next write (the mod's applyLedger, fleet-ledger), and forYouItems never lists one meanwhile.
const holdersOf = items => {
  const m = new Map()
  for (const i of items) if (i.state === 'waiting' && Array.isArray(i.awaits)) for (const id of i.awaits) if (!m.has(String(id))) m.set(String(id), i)
  return m
}
// ...and a step is the person's only while the request it unblocks is listed: not before that
// request's turn settles (owed: a request done in its turn was never anyone's), nor after it
// moved on. `held` is holdersOf's map.
const stepLive = (i, held, nowMs) => i.via !== 'step' || (held.has(i.id) && owed(held.get(i.id), nowMs))
export function settleSteps(ledger, nowMs) {
  if (!ledger || !Array.isArray(ledger.items) || !ledger.items.some(i => i.via === 'step' && forYou(i))) return ledger
  const held = holdersOf(ledger.items)
  const orphan = i => i.via === 'step' && forYou(i) && !held.has(i.id)
  if (!ledger.items.some(orphan)) return ledger
  return { ...ledger, items: ledger.items.map(i => (orphan(i) ? { ...i, state: 'dropped', closedAt: nowMs, closedBy: 'ledger', reason: 'what it waited for moved on' } : i)) }
}
// Questions answered: a request that awaited them is the session's move again once none of its
// questions is open, carrying the answer as the person's reply.
function wakeAwaiting(ledger, ids, text, at) {
  const done = new Set(ids.map(String))
  if (!ledger.items.some(i => Array.isArray(i.awaits) && i.awaits.some(id => done.has(String(id))))) return ledger
  const open = new Set(ledger.items.filter(i => i.source === QUESTION && i.state === 'open').map(i => i.id))
  return {
    ...ledger,
    items: ledger.items.map(i => {
      if (!Array.isArray(i.awaits) || !i.awaits.some(id => done.has(String(id)))) return i
      const left = i.awaits.filter(id => open.has(String(id)))
      if (left.length) return { ...i, awaits: left }
      const { awaits, ...rest } = i
      // No `asked`: the answer is on record once, as the question's (ownerAnswers).
      const reply = { at, text: excerpt(requestText(text), 200), source: 'user' }
      return { ...reopened(rest), woke: at, replies: [...(i.replies || []).filter(r => r.at !== at), reply].slice(-3) }
    }),
  }
}
// A file from before the split, read by today's rule. One shape changes: an open request whose
// last report said it waits on the person, written before such a report made an item `waiting`,
// is waiting now. Read, not rewritten: the next write keeps it, and nothing is deleted.
function reclassified(i) {
  if (i.state === 'open' && !['fleet', 'promise', QUESTION].includes(i.source) && !i.woke
      && i.progress && waitsOnPersonNote(i.progress.reason)) return { ...i, state: 'waiting' }
  return i
}

// THE QUESTIONS A TURN ENDED ON, one per numbered question. The last numbered list in the
// final text, with at most TAIL_LINES lines of closing prose after it:
//   each numbered line that asks (a "?" in it, or in the lines indented under it) is a question
//   of its own, and its lettered lines ((a) …, b) …) are its options;
//   a list with no "?" in it, under a line that asks ("Which do you want?") or above a closing
//   line that asks for a pick ("which one?", "¿cuál?"), is ONE question, its lines the options.
// Anything else ended on no question: a list of what was done with "want me to open the PR?"
// under it is an offer, and the lines above it are not its choices. Code blocks are set aside.
const NUM_LINE = /^(\s*)(?:[-*]\s+)?(?:\*\*|__)?\(?(\d{1,3})[.)](?:\*\*|__)?\s+(\S.*)$/
const SUB_LINE = /^\s*(?:[-*]\s+)?\(?([a-h])[.)]\s+(\S.*)$/i
const ASKS = /[?？]/
const PICK = /\b(which|pick|choose|prefer|option|cu[aá]l|elige|escoge|prefieres|opci[oó]n)\b/i
export const QUESTIONS_MAX = 40
const TAIL_LINES = 3
const TAIL_CHARS = 400
const tidy = s => oneLine(String(s || '').replace(/\*\*|__/g, ''))
export function turnQuestions(answer) {
  const lines = String(answer || '').replace(/\r/g, '').replace(/^\s*```[\s\S]*?^\s*```[^\n]*$/gm, '').split('\n')
  const segs = []
  let seg = null
  const leadAt = k => { for (let j = k - 1; j >= 0 && j >= k - 2; j--) if (lines[j].trim()) return NUM_LINE.test(lines[j]) ? '' : tidy(lines[j]); return '' }
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    const open = seg && !seg.closed
    const m = NUM_LINE.exec(line)
    if (m) {
      const ind = m[1].length, n = Number(m[2])
      const last = open && seg.items[seg.items.length - 1]
      if (open && ind >= seg.indent + 2) { last.more.push(tidy(line)); seg.end = k; continue }
      if (!open || n <= last.n) {
        if (open) seg.closed = true
        seg = { lead: leadAt(k), indent: ind, items: [], end: k, closed: false }
        segs.push(seg)
      }
      seg.items.push({ n, text: tidy(m[3]), subs: [], more: [] })
      seg.end = k
      continue
    }
    if (!open || !line.trim()) continue
    const it = seg.items[seg.items.length - 1]
    const s = SUB_LINE.exec(line)
    if (s) { it.subs.push({ key: s[1].toLowerCase(), text: tidy(s[2]) }); seg.end = k; continue }
    if (/^(?:\s{2,}|\t)\S/.test(line)) { it.more.push(tidy(line)); seg.end = k; continue }
    seg.closed = true
  }
  const last = segs[segs.length - 1]
  if (!last) return []
  const tail = lines.slice(last.end + 1).map(tidy).filter(Boolean)
  if (tail.length > TAIL_LINES || tail.join(' ').length > TAIL_CHARS) return []
  const asks = it => ASKS.test(it.text) || it.more.some(l => ASKS.test(l))
  const qs = last.items.filter(asks)
  if (qs.length) {
    return qs.slice(0, QUESTIONS_MAX).map(it => ({
      n: it.n, text: excerpt([it.text, ...it.more].join(' ')),
      ...(it.subs.length ? { options: it.subs.slice(0, 8).map(o => ({ key: o.key, text: excerpt(o.text, 120) })) } : {}),
    }))
  }
  const above = last.lead && ASKS.test(last.lead) ? last.lead : ''
  const ask = above || tail.find(t => ASKS.test(t) && PICK.test(t)) || ''
  if (!ask || last.items.length < 2 || last.items.length > 9 || last.items.some(it => it.text.length > 200)) return []
  // A pick asked under the list reads with the line that led into it: "Two ways to do it: …
  // Which do you prefer?" says what is being picked; "Which do you prefer?" alone does not.
  const text = above || !last.lead ? ask : `${last.lead.replace(/[:\s]+$/, '')}: ${ask}`
  return [{ text: excerpt(text), options: last.items.map(it => ({ key: String(it.n), text: excerpt(it.text, 120) })) }]
}

// Each question an item of its own, FOR YOU, carrying its number and options. The same question
// asked again while it is open (a turn that re-lists what it still needs) is that item, with
// this turn's number, so "1" means the list the person is looking at, and never a second copy.
export function addQuestions(ledger, questions, { at, turnId }) {
  if (!questions || !questions.length) return null
  let next = ledger
  const ids = []
  for (const q of questions) {
    const fields = { ...(turnId ? { turnId } : {}), ...(q.n ? { n: q.n } : {}), ...(q.options ? { options: q.options } : {}) }
    const again = next.items.find(i => i.source === QUESTION && i.state === 'open' && normAsk(i.text) === normAsk(q.text))
    if (again) {
      const { n: _n, options: _o, ...rest } = again
      next = { ...next, items: next.items.map(i => (i === again ? { ...rest, ...fields, askedAgain: at } : i)) }
      ids.push(again.id)
      continue
    }
    next = addItem(next, { text: q.text, at, turnId, source: QUESTION, asIs: true })
    const it = next.items[next.items.length - 1]
    next = { ...next, items: next.items.map(i => (i === it ? { ...i, ...fields } : i)) }
    ids.push(it.id)
  }
  return { ledger: next, ids }
}

// ── WHAT A TURN ASKS OF THE PERSON, ONCE ────────────────────────────────────────
//
// THREE MORE SOURCES. turnQuestions reads only the last numbered list, and only one that asks:
// measured on a lead's status turn, a "Waiting on you" heading over four dash bullets, mid-turn,
// with a "Possibly stalled" section and a paragraph after it, read as nothing at all; so did a
// Spanish "Pendiente tuyo" list closing on "¿Sigo con 1 (…), 2 (…) o 3 (…)?". And the judge was
// told to mark what the turn asks of the person "by":"person" and then dropped exactly those. So:
//   a waiting-on-you SECTION, anywhere in the final text (forYouSections): every bullet or number
//     under the heading is one item, in the agent's words
//   a CLOSING CHOICE on one line with its options inline (inlineChoice): ONE item whose options
//     are the numbers, so "2" picks the second
//   the judge's "by":"person" lines (personAsks), matched against what is already open
// ONCE. One thing asked of the person is one item per session. Two sources that find it are one
// item (turnAsks); a later turn that lists it again in other words is that item, its words
// updated and its id kept (matchAsks, askScore); a turn with a list REPLACES the list before it,
// and what the new list no longer carries is closed as NOT_LISTED, never deleted. A turn with no
// list leaves the open ones alone. Rewordings past what shared words can tell are put to the
// judge (`relist`), which pairs them by id.
const LIST_LINE = /^(\s*)(?:[-*•+]|(\d{1,3})[.)])\s+(?:\[[ xX]\]\s+)?(\S.*)$/
const HEAD_KEY = new RegExp(String.raw`^(?:(?:still|also|todav[ií]a|a[uú]n)\s+)?(?:` + [
  String.raw`waiting\s+(?:on|for)\s+(?:you|the\s+(?:person|owner|user))`,
  String.raw`needs?\s+(?:you|your\s+[\w-]+)`,
  String.raw`for\s+you(?:\s+to\s+[\w-]+)?`,
  String.raw`your\s+(?:call|move|turn|decisions?|input|actions?|answers?|side|part)`,
  String.raw`(?:what\s+)?i\s+need\s+from\s+you`,
  String.raw`pendientes?\s+(?:tuyos?|tuyas?|de\s+ti|para\s+ti|por\s+tu\s+parte)`,
  String.raw`lo\s+que\s+(?:necesito|falta)\s+de\s+ti`,
  String.raw`necesito\s+de\s+ti`,
  String.raw`para\s+ti`,
  String.raw`te\s+toca`,
  String.raw`esperando\s+(?:tu|tus|por\s+ti|que\s+t[uú])`,
].join('|') + String.raw`)(?![\w-])`, 'i')
const NONE = /^(?:nothing|none|n\/a|nada|ninguno|ninguna|no hay nada|—|–|-)(?:\b|$)/i
const turnLines = answer => String(answer || '').replace(/\r/g, '').replace(/^\s*```[\s\S]*?^\s*```[^\n]*$/gm, '').split('\n')
// A heading names the section and says nothing else: alone on its line ("**Waiting on you**",
// "## Pendiente tuyo", "Te toca:"), or a short label and a colon with one item after it
// ("**Needs you:** merge #12"). A sentence that merely starts with the words is prose.
function forYouHeading(line) {
  const raw = String(line || '').trim()
  if (!raw || raw.length > 160) return null
  const md = /^#{1,6}\s+/.test(raw)
  const t = raw.replace(/^#{1,6}\s+/, '')
  const bold = /^(\*\*|__)(.+?)\1\s*:?\s*$/.test(t)
  const plain = tidy(t).replace(/^[*_]+|[*_]+$/g, '').trim()
  const m = HEAD_KEY.exec(plain)
  if (!m) return null
  const rest = plain.slice(m[0].length)
  if (/^\s*(?:\([^)]{0,20}\))?\s*[:：]?\s*$/.test(rest)) return { inline: '' }
  const tailed = /^([^:：.?!,]{0,40})[:：]\s*(.*)$/.exec(rest)
  if (tailed) return { inline: tidy(tailed[2]) }
  if ((md || bold) && rest.length <= 48 && !/[.?!,]/.test(rest)) return { inline: '' }
  return null
}
// null when the turn has no such heading at all; else every item under every one (maybe none).
export function forYouSections(answer) {
  const lines = turnLines(answer)
  let found = null
  for (let k = 0; k < lines.length; k++) {
    const li = LIST_LINE.exec(lines[k])
    const h = forYouHeading(li ? li[3] : lines[k])
    if (!h) continue
    found = found || []
    // A heading that is itself a bullet ("- **Needs you:** …") owns only what is indented under it.
    const own = li ? li[1].length : -1
    const got = []
    let base = null, cur = null, blank = false, j = k + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim()) { blank = true; continue }
      const ind = line.match(/^\s*/)[0].length
      const m = LIST_LINE.exec(line)
      if (own >= 0 && ind <= own) break
      if (m && (base === null || ind <= base)) {
        if (forYouHeading(m[3]) && base !== null) break
        base = base === null ? ind : base
        cur = { text: m[3], n: m[2] ? Number(m[2]) : 0, more: [], subs: [] }
        got.push(cur)
        blank = false
        continue
      }
      if (cur && ind > base && (m || !blank)) {
        const s = SUB_LINE.exec(line)
        if (s) cur.subs.push({ key: s[1].toLowerCase(), text: tidy(s[2]) })
        else cur.more.push(tidy(line))
        continue
      }
      break
    }
    for (const it of got) {
      const text = tidy([it.text, ...it.more].join(' '))
      if (!text || (text.length <= 40 && NONE.test(text))) continue
      found.push({
        text: excerpt(text), via: 'section', ...(it.n ? { n: it.n } : {}),
        ...(it.subs.length ? { options: it.subs.slice(0, 8).map(o => ({ key: o.key, text: excerpt(o.text, 120) })) } : {}),
      })
    }
    if (!got.length && h.inline && !(h.inline.length <= 40 && NONE.test(h.inline))) found.push({ text: excerpt(h.inline), via: 'section' })
    k = j - 1
  }
  return found
}
// "¿Sigo con 1 (#12), 2 (#13 y #14) o 3 (retomar los workers)?": one question, near the end, its
// options numbered from 1 in the line itself.
const CHOICE_OPT = /(?:^|[\s,;:¿(])(\d{1,2})\s*\(([^()\n]{1,120})\)/g
export function inlineChoice(answer) {
  const lines = turnLines(answer).map(l => l.trim()).filter(Boolean)
  for (const line of lines.slice(-TAIL_LINES).reverse()) {
    if (!ASKS.test(line)) continue
    const opts = [...line.matchAll(CHOICE_OPT)].map(m => ({ key: m[1], text: tidy(m[2]) }))
    if (opts.length < 2 || opts.some((o, k) => Number(o.key) !== k + 1)) continue
    return { text: excerpt(tidy(line)), via: 'choice', options: opts.slice(0, 9).map(o => ({ key: o.key, text: excerpt(o.text, 120) })) }
  }
  return null
}
// Everything a turn's final text asks of the person: `list` its waiting-on-you section (null when
// it has none: a turn with no list replaces nothing), `asks` its numbered questions and its
// closing choice. NUMBERS mean what the person is looking at: a closing choice takes a bare
// number (settleQuestions), so then the list's lines carry none; a list's own numbers are kept
// unless a numbered question list after it uses them; a bulleted list is numbered in its order
// when nothing else in the turn is.
export function turnForYou(answer) {
  let list = forYouSections(answer)
  const qs = turnQuestions(answer).map(q => ({ ...q, via: 'numbered' }))
  const choice = inlineChoice(answer)
  const asks = [...qs, ...(choice ? [choice] : [])]
  if (list) {
    const taken = new Set(qs.filter(q => q.n).map(q => q.n))
    const strip = ({ n, ...a }) => a
    if (choice) list = list.map(strip)
    else if (taken.size) list = list.map(a => (a.n && taken.has(a.n) && !qs.some(q => normAsk(q.text) === normAsk(a.text)) ? strip(a) : a))
    else if (!list.some(a => a.n)) list = list.map((a, k) => ({ ...a, n: k + 1 }))
  }
  return { list, asks }
}

// Two phrasings of one thing asked of the person. Content words (stemmed, in English and Spanish,
// accents folded) and ANCHORS, the parts a rewording keeps: a PR's #number, a code span, a path, a
// hyphenated name, a number. Two different #numbers are two different things, whatever else they
// share. Otherwise: two shared words, and half the shorter's words, or a third with an anchor.
const FY_STOP = new Set(('you your yours please pls need needs needed still also now here there what which whether should would '
  + 'could can do does tu tus te ti tuyo tuya tuyos tuyas usted de la el los las y o u que en un una unos unas con por para del al '
  + 'lo se es son esta este esto ese esa eso si no ya mas muy pero como cuando donde sobre entre hay').split(' '))
const fold = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const ANCHOR = /#\d+|`[^`\n]+`|\b\d{2,}\b|\b[a-z0-9]+(?:[-_/.][a-z0-9]+)+\b/g
const anchorsOf = t => new Set((fold(t).match(ANCHOR) || []).map(s => s.replace(/`/g, '').replace(/[.]+$/, '')))
const askWords = t => new Set(fold(t).replace(/[’']/g, '').split(/[^a-z0-9.\-/]+/)
  .map(w => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
  .filter(w => w && !STOP.has(w) && !FY_STOP.has(w))
  .map(w => (LOOK.has(w) ? 'check' : stem(w))).filter(w => w.length >= 2))
export function askScore(a, b) {
  if (normAsk(a) === normAsk(b)) return 1000
  const A = anchorsOf(a), B = anchorsOf(b)
  const na = [...A].filter(x => x.startsWith('#')), nb = [...B].filter(x => x.startsWith('#'))
  if (na.length && nb.length && !na.some(x => nb.includes(x))) return 0
  const x = askWords(a), y = askWords(b)
  if (!x.size || !y.size) return 0
  const shared = [...x].filter(w => y.has(w)).length
  if (shared < 2) return 0
  const anchored = [...A].filter(w => B.has(w)).length
  const share = shared / Math.min(x.size, y.size)
  return share >= 0.5 || (anchored && share >= 0.3) ? Math.round(share * 100) + anchored * 20 + shared : 0
}
export const sameAsk = (a, b) => askScore(a, b) > 0
// Each found item to the one open item it restates, best pairs first, each used once.
function matchAsks(asks, pool) {
  const cand = []
  asks.forEach((a, k) => { for (const i of pool) { const s = askScore(a.text, i.text); if (s > 0) cand.push({ k, i, s }) } })
  cand.sort((x, y) => y.s - x.s || Number(y.i.id) - Number(x.i.id))
  const out = new Map(), used = new Set()
  for (const c of cand) if (!out.has(c.k) && !used.has(c.i.id)) { out.set(c.k, c.i); used.add(c.i.id) }
  return out
}
// One turn's sources as one list: a numbered question that IS a line of the list (the same words)
// is that line, carrying its number and options. Words only, never a looser match: two lines of
// one turn are two things the agent chose to write apart.
function turnAsks(found) {
  const out = [...(found.list || [])]
  for (const q of found.asks || []) {
    const k = out.findIndex(a => normAsk(a.text) === normAsk(q.text))
    if (k < 0) { out.push(q); continue }
    out[k] = { ...out[k], ...(q.n && !out[k].n ? { n: q.n } : {}), ...(q.options && !out[k].options ? { options: q.options } : {}) }
  }
  return out
}
function addAsk(ledger, a, { at, turnId }, ids) {
  let next = addItem(ledger, { text: a.text, at, turnId, source: QUESTION, asIs: true })
  const it = next.items[next.items.length - 1]
  next = { ...next, items: next.items.map(i => (i === it ? { ...i, via: a.via, ...(a.n ? { n: a.n } : {}), ...(a.options ? { options: a.options } : {}) } : i)) }
  ids.push(it.id)
  return next
}
// Listed again: the newest words, this turn's number and options, the same id.
function relisted(i, a, { at, turnId }) {
  const { n: _n, options: _o, ...rest } = i
  return {
    ...rest, text: a.text, ...(turnId ? { turnId } : {}), ...(a.n ? { n: a.n } : {}), ...(a.options ? { options: a.options } : {}),
    ...(a.via === 'section' || !i.via ? { via: a.via } : {}), askedAgain: at,
  }
}
export const NOT_LISTED = 'no longer listed'
const unlist = (ledger, ids, at) => ({
  ...ledger, items: ledger.items.map(i => (ids.includes(i.id) && forYou(i) ? { ...i, state: 'dropped', closedAt: at, closedBy: 'ledger', reason: NOT_LISTED } : i)),
})
// What only a list replaces: its own lines, the judge's reading of earlier ones, and the steps.
// A numbered question is answered or asked again, never retired by a list that left it out.
const REPLACED = new Set(['section', 'judge', 'step'])
// The stamp: a ledger whose turns this code has read (captureForYou) or whose last turn it has
// read on its first start (upgradeForYou). A file without it is read once, never twice.
export const FOR_YOU_V = 2
export const BEFORE_UPGRADE = 'before-upgrade'
// `found` is turnForYou's. `hold`: a judge will read this turn, so a list whose new lines match
// nothing while lines of the list before are left over is held for it (`relist`) rather than read
// as new items beside retired ones; the judge's pairs, or none, settle it (resolveRelist).
// `backfill`: the turn is one read before (upgradeForYou), so whatever matches an item already
// asked, answered or not, was asked then, and nothing is retired.
export function captureForYou(ledger, found, { at, turnId, hold = false, backfill = false }) {
  // This turn read again (a turn queued behind a judge is completed twice): its list is held already.
  if (ledger.relist && turnId && ledger.relist.turnId === turnId) return null
  let next = ledger.relist ? resolveRelist(ledger, [], { at }) : ledger
  const asks = turnAsks(found)
  const pool = next.items.filter(i => i.source === QUESTION && (backfill || i.state === 'open'))
  const pair = matchAsks(asks, pool)
  const ids = []
  const fresh = []
  asks.forEach((a, k) => {
    const old = pair.get(k)
    if (!old) { fresh.push(a); return }
    if (backfill) return
    ids.push(old.id)
    next = { ...next, items: next.items.map(i => (i.id === old.id ? relisted(i, a, { at, turnId }) : i)) }
  })
  const matched = new Set([...pair.values()].map(i => i.id))
  const gone = found.list && !backfill ? next.items.filter(i => forYou(i) && REPLACED.has(i.via) && !matched.has(i.id)) : []
  const loose = fresh.filter(a => a.via === 'section')
  if (hold && gone.length && loose.length) {
    for (const a of fresh.filter(a => a.via !== 'section')) next = addAsk(next, a, { at, turnId }, ids)
    return { ledger: { ...next, forYouV: FOR_YOU_V, relist: { turnId, at, items: loose, old: gone.map(i => i.id) } }, ids, held: true }
  }
  for (const a of fresh) next = addAsk(next, a, { at, turnId }, ids)
  if (gone.length) next = unlist(next, gone.map(i => i.id), at)
  if (next === ledger && ledger.forYouV === FOR_YOU_V) return null
  return { ledger: { ...next, forYouV: FOR_YOU_V }, ids }
}
// The held list, settled: each pair (`new` is the list line's number in the judge's prompt, from
// 1; `old` an id still open) keeps the old id with the new words; a line left unpaired is a new
// item, and an old one left unpaired is no longer listed.
export function resolveRelist(ledger, pairs, { at }) {
  const r = ledger.relist
  if (!r) return ledger
  const { relist: _r, ...rest } = ledger
  let next = rest
  const by = new Map(), used = new Set()
  for (const p of pairs || []) {
    const k = Number(String(p.new ?? '').replace(/^n/i, '')) - 1, id = String(p.old ?? '')
    if (!r.items[k] || by.has(k) || used.has(id) || !r.old.includes(id)) continue
    if (!next.items.some(i => i.id === id && forYou(i))) continue
    by.set(k, id)
    used.add(id)
  }
  r.items.forEach((a, k) => {
    const id = by.get(k)
    if (id) next = { ...next, items: next.items.map(i => (i.id === id ? relisted(i, a, { at: r.at, turnId: r.turnId }) : i)) }
    else next = addAsk(next, a, { at: r.at, turnId: r.turnId }, [])
  })
  const gone = r.old.filter(id => !used.has(id))
  return gone.length ? unlist(next, gone, at) : next
}
// What the judge read as asked of the person (parseVerdict's forPerson): an item only when nothing
// open already is it. `same` is the judge naming the open item; failing that, the words decide.
// The open item's text stays the agent's own: the judge's words are its reading, not the ask.
export function personAsks(ledger, asks, { at, turnId }) {
  let next = ledger
  for (const p of asks || []) {
    const open = next.items.filter(forYou)
    if ((p.same && open.some(i => i.id === p.same)) || open.some(i => sameAsk(i.text, p.text))) continue
    next = addAsk(next, { text: excerpt(p.text), via: 'judge' }, { at, turnId }, [])
  }
  return next
}

// WHAT IS PENDING NOW, SHOWN ON DEPLOY. A ledger from before this code holds none of what its
// session's last turn asked through a list or a closing choice, and its held requests have no step
// for the person. Read once, at the session's first start under this code (register.js
// upgradeLedger), and stamped, so it never runs twice: the last turn's text (lastTurnText) read as
// a turn would be (captureForYou, backfill), and every held request given what it waits on (stepFor).
export function upgradeForYou(ledger, lastText, { at }) {
  if (!ledger || Number(ledger.forYouV) >= FOR_YOU_V) return null
  let next = ledger
  const r = lastText ? captureForYou(next, turnForYou(lastText), { at, turnId: BEFORE_UPGRADE, backfill: true }) : null
  if (r) next = r.ledger
  for (const h of next.items.filter(i => i.state === 'waiting' && owes(i) && !awaiting(i))) next = stepFor(next, h, { turnId: '', at })
  return { ...next, forYouV: FOR_YOU_V }
}
// The final text of the session's last turn, from its messages ($.session.messages()): '' when the
// person has written since (their reply is being answered; the next turn lists what is left) or
// when that turn answered an explain request (an explanation asks nothing new).
export function lastTurnText(messages) {
  const list = Array.isArray(messages) ? messages : []
  const said = m => m && m.role === 'user' && String(m.text || '').trim() && !(m.toolResults && m.toolResults.length)
  let k = list.length - 1
  while (k >= 0 && !(list[k] && list[k].role === 'assistant' && String(list[k].text || '').trim())) {
    if (said(list[k])) return ''
    k--
  }
  if (k < 0) return ''
  for (let j = k - 1; j >= 0; j--) if (said(list[j])) { if (explainOf(list[j].text)) return ''; break }
  return String(list[k].text)
}

// THE PERSON'S ANSWER BY NUMBER: "1", "3a", "1 a", "sí al 3", "1: yes, 2: no", "2 y 4", one line
// per answer. Each answers the question of that number from the turn that asked (choiceTurn) and
// nothing older, since "1" means the list in front of them. A list that was ONE question with
// numbered choices takes the number as its choice. A bare "yes" answers the turn's question when
// it asked one; "all yes", "sí a todo" answers every one. A loose mention never answers one:
// that is two shared words (mentions), and a decision from the owner never decays.
// A number that only starts a sentence ("3 more things: …", "2 tests fail") is not an answer:
// after a bare space the rest must read as one (ANSWER_WORD), or be three words at most.
const REF_HEAD = /^\s*(?:q|#)?\(?(\d{1,3})([a-h])?\)?(?![\d%])(\s*[.):=\-–—]\s*|\s+|$)(.*)$/i
const ANSWER_WORD = /^(?:yes|yeah|yep|no|nope|s[ií]|ok|okay|dale|go|sure|claro|skip|later|wait|drop|keep|use|both|none|neither|ninguno|ninguna|todos|todas|all|mejor|después|despues|primero|nah|correct|right|agreed|de acuerdo|vale|perfecto|perfect|fine|good|bien|mal)\b/i
const REF_SAID = /(?:^|\s)(?:(?:s[ií]|yes|no|ok|okay|dale)\s+(?:al|a la|a|to|for|on|en|para el|para la)\s+|(?:punto|pregunta|question|item|option|opci[oó]n|n[uú]mero|number|#)\s*)(\d{1,3})([a-h])?\b/i
const REF_SPLIT = /\n|[;,]|\s+(?:y|e|and|&)\s+(?=(?:q|#)?\(?\d)/i
const YES_ALL = /^(?:(?:yes|s[ií]|ok|dale|go)\s+(?:to\s+|a\s+)?(?:all|todo|todos|todas)|(?:all|todos|todas)\s+(?:yes|s[ií]|ok)|both|ambos|ambas)[.!]*$/i
const YES = /^(?:yes|yeah|yep|y|s[ií]|ok|okay|dale|sure|claro|go ahead|de una)[.!]*$/i
export function answerRefs(text) {
  const body = unquote(String(text || '').replace(PASTE, ' '))
  if (!oneLine(body) || oneLine(body).length > ANSWER_MAX) return []
  const refs = []
  for (const part of body.split(REF_SPLIT)) {
    const seg = oneLine(part)
    if (!seg) continue
    const m = REF_HEAD.exec(seg)
    const bare = m && !m[3].trim() && m[4]
    if (m && (!bare || ANSWER_WORD.test(m[4]) || /^\(?[a-h]\)?[.)]?(?:\s|$)/i.test(m[4]) || m[4].split(/\s+/).length <= 3)) {
      let opt = (m[2] || '').toLowerCase(), rest = oneLine(m[4])
      const lone = /^\(?([a-h])\)?[.)]?(?:\s+(.*))?$/i.exec(rest)
      if (!opt && lone) { opt = lone[1].toLowerCase(); rest = oneLine(lone[2]) }
      refs.push({ n: Number(m[1]), opt, said: seg, rest })
      continue
    }
    const s = REF_SAID.exec(seg)
    if (s) { refs.push({ n: Number(s[1]), opt: (s[2] || '').toLowerCase(), said: seg, rest: seg }); continue }
    // words that run on after a comma belong to the answer before them: "5: no, use JSON"
    if (refs.length) { const r = refs[refs.length - 1]; r.rest = oneLine(`${r.rest} ${seg}`); r.said = `${r.said}, ${seg}` }
  }
  return refs
}
const optionText = (q, key) => ((q.options || []).find(o => o.key === key) || {}).text || ''
const answered = (i, a, at) => ({ ...i, state: 'done', closedAt: at, closedBy: 'person', answer: { ...a, at } })
// A REPLY THAT NAMES ITS ITEM: the phone's and the desk's reply box (web/ui/queue.jsx replyText)
// sends `Re your ledger item <id>: "<its text>"` and then the person's words. The id is the
// ledger's, not the question's number in its turn, so read as a numbered answer it would settle
// whichever question of the latest turn happened to carry that number. It settles that item, from
// any turn, and nothing else.
const REPLY_HEAD = /^\s*Re your ledger item (\d+): "[^\n]*"\s*(?:\n([\s\S]*))?$/
export function replyOf(text) {
  const m = REPLY_HEAD.exec(String(text || ''))
  return m ? { id: m[1], said: oneLine(m[2] || '') } : null
}
function optionPicked(q, said) {
  const m = /^\(?([a-h]|\d{1,2})\)?(?:[.):]|\s|$)/i.exec(said)
  if (m && optionText(q, m[1].toLowerCase())) return m[1].toLowerCase()
  const o = (q.options || []).find(x => oneLine(x.text).toLowerCase() === said.toLowerCase())
  return o ? String(o.key) : ''
}
export function settleQuestions(ledger, text, { at, choiceTurn }) {
  const reply = replyOf(text)
  if (reply) {
    const q = ledger.items.find(i => i.id === reply.id && i.source === QUESTION && i.state === 'open')
    if (!q || !reply.said) return null
    const key = optionPicked(q, reply.said), o = key ? optionText(q, key) : ''
    const a = { text: excerpt(o && !reply.said.includes(o) ? `${reply.said} (${o})` : reply.said, 200), ...(key ? { option: key } : {}) }
    return { ledger: wakeAwaiting({ ...ledger, items: ledger.items.map(i => (i === q ? answered(i, a, at) : i)) }, [q.id], reply.said, at), ids: [q.id] }
  }
  if (!choiceTurn) return null
  const asked = ledger.items.filter(i => i.source === QUESTION && i.state === 'open' && i.turnId === choiceTurn)
  if (!asked.length) return null
  const said = requestText(text)
  if (!said || said.length > ANSWER_MAX) return null
  const one = asked.length === 1 ? asked[0] : null
  // The question whose options are numbers: the turn's only one, or its closing choice (a turn
  // can list what waits on the person and then ask "1 (…), 2 (…) or 3 (…)?"; "2" is the pick,
  // the last thing asked, and never the second line of the list).
  const choices = asked.filter(i => i.via === 'choice' && !i.n)
  const choice = one && !one.n ? one : choices.length === 1 ? choices[0] : null
  const picks = new Map()
  const pick = (q, key, words) => {
    const o = key ? optionText(q, key) : ''
    picks.set(q.id, { text: excerpt(o ? `${words} (${o})` : words, 200), ...(o ? { option: key } : {}) })
  }
  if (YES_ALL.test(said)) for (const q of asked) pick(q, '', said)
  else {
    for (const r of answerRefs(text)) {
      if (choice && optionText(choice, String(r.n))) { pick(choice, String(r.n), r.said); continue }
      const q = asked.find(i => Number(i.n) === r.n)
      if (q) pick(q, r.opt && optionText(q, r.opt) ? r.opt : '', r.said)
    }
    const letter = /^\(?([a-h])\)?[.)]?$/i.exec(said)
    // "ok go with 2" to the one question whose options are numbered: the one number it names,
    // when that number is one of the options. Short replies only: past a line it is a new ask.
    const nums = choice && said.length <= 60 ? [...new Set(said.match(/(?<![\w.#$])\d{1,2}(?![\w.%:])/g) || [])] : []
    if (!picks.size && one && letter && optionText(one, letter[1].toLowerCase())) pick(one, letter[1].toLowerCase(), said)
    else if (!picks.size && nums.length === 1 && optionText(choice, nums[0])) pick(choice, nums[0], said)
    else if (!picks.size && one && YES.test(said)) pick(one, '', said)
  }
  if (!picks.size) return null
  return { ledger: wakeAwaiting({ ...ledger, items: ledger.items.map(i => (picks.has(i.id) ? answered(i, picks.get(i.id), at) : i)) }, [...picks.keys()], said, at), ids: [...picks.keys()] }
}

// An answer given outside the conversation: the phone's or the desk's option button, or
// `fleet-ledger answer <id> "<words>"`. A question is answered (done, the person's); a request
// held waiting on them is the agent's move again, with their words as a reply. Either way the
// session is told in a message of its own (the caller sends it), and this is the ledger's half.
export function answerItem(ledger, id, text, { nowMs, option = '' }) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  if (!it) return { ledger: null, said: `ledger: no item ${id}` }
  // A request held on the person is the agent's, but answering it by hand still hands it back.
  if (!forYou(it) && !(it.state === 'waiting' && owes(it))) return { ledger: null, said: `ledger: item ${it.id} is not waiting on the person (${it.state})` }
  const words = oneLine(text)
  if (!words) return { ledger: null, said: `ledger: ${it.id} not answered: the answer is empty` }
  const key = String(option || '').trim().toLowerCase()
  const o = key ? optionText(it, key) : ''
  const next = it.source === QUESTION
    ? answered(it, { text: excerpt(o && !words.includes(o) ? `${words} (${o})` : words, 200), ...(o ? { option: key } : {}) }, nowMs)
    : { ...reopened(it), woke: nowMs, replies: [...(it.replies || []), { at: nowMs, text: excerpt(words, 200), source: 'user', asked: excerpt(it.text, 400) }].slice(-3) }
  const out = { ...ledger, items: ledger.items.map(i => (i === it ? next : i)) }
  return { ledger: it.source === QUESTION ? wakeAwaiting(out, [it.id], o && !words.includes(o) ? `${words} (${o})` : words, nowMs) : out, said: `ledger: ${it.id} answered` }
}

// What the person sees as theirs, one row per for-you item, oldest first and a turn's questions
// in their order: the phone's list (fleet-serve /api/waiting, the team app's), the band's count
// (ledgerSummary) and the briefing (through ledgerChanges). No age limit: see FOR YOU.
export function forYouItems(ledger, nowMs) {
  const rows = []
  const held = holdersOf(ledger.items)
  for (const i of ledger.items) {
    // Theirs once the turn that made it is over, as everything owed is (owed).
    if (!forYou(i) || !owed(i, nowMs)) continue
    // A step says what to do for one held request: with that request moved on it asks nothing
    // (settleSteps closes it at the next write), and its card says what answering it unblocks.
    if (!stepLive(i, held, nowMs)) continue
    const h = held.get(i.id)
    rows.push({
      id: i.id, text: excerpt(i.text), source: i.source, at: Number(i.at) || 0, state: 'question',
      reason: i.via === 'step' ? excerpt(`unblocks: ${oneLine(h.text)}`, 160) : '',
      since: Number(i.askedAgain) || Number(i.at) || 0,
      ...(i.n ? { n: Number(i.n) } : {}), ...(i.options ? { options: i.options } : {}), ...(i.explain ? { explain: i.explain } : {}),
    })
  }
  return rows.sort((a, b) => a.since - b.since || (a.n || 0) - (b.n || 0) || Number(a.id) - Number(b.id))
}

// ── EXPLÍCAME: one for-you item, explained by the session that raised it ──────────
// The person taps "explain" on an item and the SESSION THAT ASKED it says, in plain words and in
// their language, what is being decided, what each option causes and what it recommends. No other
// model: the one that asked is the one that knows. It is a prompt like any other, so it waits for
// its turn (fleet-send queues behind a running turn; /ledger explain submits once idle) and never
// interrupts one. Marked as an explain request by its delivery (`kind: "explain"`), never by its
// words; it makes no item, is not judged, and its turn's text is kept on the item (`explain`).
export const EXPLAIN_HEAD = '[ghostfleet ledger: explain'
export const explainOf = text => { const m = /^\s*\[ghostfleet ledger: explain (\d+)\]/.exec(String(text || '')); return m ? m[1] : '' }
const ES_WORDS = /\b(el|la|los|las|que|de|del|por|para|con|una?|es|esto|eso|pero|como|tambien|tenemos|puedes|hazlo|dale|porque|cuando|donde|ya|muy|ahora|hay|bien|aqui|todo|esta)\b/gi
const ES_MARKS = /[ñáéíóú¿¡]/gi
const EN_WORDS = /\b(the|and|is|are|to|of|it|that|this|with|for|you|can|please|should|what|how|why|when|we|do|does|not|just|make|fix)\b/gi
const count = (t, re) => (String(t).match(re) || []).length
export function langOf(text) {
  const t = String(text || '')
  return count(t, ES_WORDS) + count(t, ES_MARKS) > count(t, EN_WORDS) ? 'es' : 'en'
}
// The person's language is the one they write in here: their own last words in this ledger.
export function personLang(ledger, fallback = '') {
  const said = ledger.items.filter(i => i.source === 'user').slice(-12).map(i => i.text).join(' ')
  return said.trim() ? langOf(said) : fallback ? langOf(fallback) : 'en'
}
export function explainPrompt(item, { lang = 'en' } = {}) {
  const opts = (item.options || []).map(o => `${o.key}) ${o.text}`)
  return [
    `${EXPLAIN_HEAD} ${item.id}] The person tapped "explain" on ledger item ${item.id}, ${item.source === QUESTION ? 'a question you asked them' : 'something you are holding until they decide or act'}:`,
    `"${excerpt(item.text, 240)}"`,
    ...(opts.length ? [`Its options: ${opts.join('; ')}`] : []),
    ...(item.progress && item.progress.reason ? [`What you last said about it: ${excerpt(item.progress.reason, 160)}`] : []),
    `Explain this one item to them in plain, simple words${lang === 'es' ? ', IN SPANISH (they write in Spanish)' : ''}: what is being decided, what each option would cause, and which one you recommend and why. At most 120 words, no code and no jargon. Do not do any work or change anything, and do not answer other items: only explain. (The ledger keeps your answer for them.)`,
  ].join('\n')
}
export function markExplainAsked(ledger, id, { nowMs, lang }) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  if (!it) return { ledger: null, said: `ledger: no item ${id}` }
  if (!forYou(it)) return { ledger: null, said: `ledger: item ${it.id} is not waiting on the person (${it.state})` }
  const explain = { askedAt: nowMs, lang: lang || 'en' }
  return { ledger: { ...ledger, items: ledger.items.map(i => (i === it ? { ...i, explain } : i)) }, item: it, said: `ledger: asked for an explanation of ${it.id}` }
}
// The send never reached the session (no such session, a dead fleet): said on the item, so the
// sheet stops waiting and says why, instead of "waiting for the session" forever.
export function explainFailed(ledger, id, why, nowMs) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  if (!it || !it.explain) return { ledger: null, said: `ledger: no explanation was asked of ${id}` }
  const explain = { ...it.explain, failed: excerpt(oneLine(why) || 'the request could not be sent', 200), failedAt: nowMs }
  return { ledger: { ...ledger, items: ledger.items.map(i => (i === it ? { ...i, explain } : i)) }, said: `ledger: ${it.id} could not be explained` }
}
export const EXPLAIN_MAX = 2000
export function setExplanation(ledger, id, text, nowMs) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  const t = String(text || '').trim()
  if (!it || !t) return null
  const explain = { ...(it.explain || {}), at: nowMs, text: t.length > EXPLAIN_MAX ? `${t.slice(0, EXPLAIN_MAX - 1)}…` : t }
  return { ...ledger, items: ledger.items.map(i => (i === it ? { ...i, explain } : i)) }
}

// The items the gate may re-prompt about: open, fresh, never gated before, from the latest
// prompt's window (addPrompt); promises only when promises gate. An older item stays on the
// band and in /ledger, closable by the agent, the judge or the person, and is never named
// again: a session that moved on from it was answering what it was asked next, and a gate
// that reached back made every turn's end about the backlog instead of the turn.
//
// An item a turn reported in progress (`progress`, applyVerdict) is never a target: "open"
// lumped together the item a turn ignored and the item it reported on while the work went on
// in a worker, and the gate re-prompted both. Seen live: the person picked options with a
// three-word reply, the agent dispatched a worker to build them and ended on "dry run done,
// the build is in progress in a worker, I'll ship it when it lands"; the judge kept it open
// (correctly, it was not finished), the gate said "finish it now", and all the agent could do
// was repeat the same report. Only the ignored item is owed a nudge.
export function gateTargets(ledger, nowMs, { promises }) {
  const from = Number(ledger.window) || 0
  return openItems(ledger, nowMs).filter(i => !i.gated && !i.progress && !i.answered && from && Number(i.prompt) >= from
    && (i.source !== 'promise' || promises === 'gate'))
}

// When a turn's end is not re-prompted at all, whatever is open; '' when the gate may go on.
// Each is a turn whose re-prompt could only be answered with the report it just gave:
//   gate-turn     the turn the gate's own re-prompt started. Its items are already gated, but
//                 one judged open in the same prompt window would be named in a second
//                 re-prompt straight after the first: the nag answering itself
//   waiting       the turn ended asking the person something, or waiting on their decision
//                 (the judge's `waitingOnPerson`): the next move is theirs, and a re-prompt
//                 lands on top of the question they are reading
//   cooldown      a re-prompt went out less than GATE_COOLDOWN_MS ago
//   workers       a lead whose workers are still working, or waiting on a person (the band's
//                 count): the report is the work's state, and it moves without the agent
// NOT the session's own background shells. The engine hands them to Stop hooks
// (`background_tasks`), but `classic.Stop` never reaches a user-tier mod: measured, the debug
// log reads "ghostfleet: classic.Stop bypassed by cc-plugin-sec-default (tier user)" on every
// turn, while the harness delivers it and a test of it passes. The footer's "1 shell still
// running" is a pane regex, which is the guess this mod exists to replace.
// Five minutes: a re-prompt's own turn and the one after it come well inside that, while a
// separate ask the person makes later in the session is still owed its nudge. The window is
// read from the items' `gatedAt`, so a reload does not reset it.
export const GATE_COOLDOWN_MS = 5 * 60_000
export const lastGateAt = ledger => Math.max(0, ...ledger.items.map(i => Math.max(Number(i.gatedAt) || 0, Number(i.proofAskedAt) || 0)))
export function gateHold({ gateTurn, waitingOnPerson, lastGate = 0, nowMs, workers = 0 }) {
  if (gateTurn) return 'gate-turn'
  if (waitingOnPerson) return 'waiting'
  if (lastGate && nowMs - lastGate < GATE_COOLDOWN_MS) return 'cooldown'
  if (workers > 0) return 'workers'
  return ''
}

// The turn the gate's re-prompt started, by its text: what the gate submits opens with this
// head, and a plugin's framed submit may arrive with its frame in front.
export const GATE_HEAD = '[ghostfleet ledger]'
export const isGateTurn = text => {
  const t = String(text || '').trimStart()
  return t.startsWith(GATE_HEAD) || /^The ghostfleet plugin sent a message:\s*\[ghostfleet ledger\]/.test(t)
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
export function markInterrupted(ledger, turnId, nowMs) {
  if (!turnId || !ledger.items.some(i => i.turnId === turnId && i.state === 'open' && i.source !== 'promise')) return null
  return {
    ...ledger,
    items: ledger.items.map(i => (i.turnId === turnId && i.state === 'open' && i.source !== 'promise'
      ? { ...i, interrupted: true, ...(nowMs ? { interruptedAt: nowMs } : {}) } : i)),
  }
}

export const dropItems = (ledger, ids) => ({ ...ledger, items: ledger.items.filter(i => !ids.includes(i.id)) })

export function gatePrompt(items) {
  const lines = items.map(i => `${i.id}. ${i.source === 'promise' ? '(you said you would) ' : ''}"${excerpt(i.text, 160)}"`)
  return [
    `${GATE_HEAD} ${items.length === 1 ? 'One request is' : `${items.length} requests are`} still open from this session:`,
    ...lines,
    `Finish each one now and close it from Bash with ${CLI.close}, or say for each that it is not done and why (${CLI.drop} if it was not a real ask). (Asked once per item; it will not be asked again.)`,
  ].join('\n')
}

export const markGated = (ledger, ids, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (ids.includes(i.id) ? { ...i, gated: true, gatedAt: nowMs } : i)),
})

// The briefs the judge read as answered in THIS turn and that were never asked for their proof.
// The bound is in the data, like `gated`: an item carries `proofAskedAt` once asked and is never
// asked again, across reloads too. With the holds the gate already has (gateHold: the nudge's
// own turn is a gate turn and is never re-prompted, nor is one inside the cooldown), a worker
// that ended its turn is woken at most once per brief, however many turns the judge goes on
// reading it as answered. One that answers the nudge without proof keeps the item open, listed
// "[answered, no proof]", and is not woken for it again. Not limited to the latest prompt's
// window: a brief answered now is owed its proof now, whenever it was sent.
//   Never an item CARRIED from a stopped worker (carryItems). It needs proof as any brief does,
// since a worker that stopped without proving it is exactly the judge-done this rule refuses,
// whatever it was in the worker (an ask, a brief, a promise); but it is never re-prompted at the
// lead's turn end, because the lead's turn was not asked it. The lead's note lists it with the
// close-with-proof rule, and /ledger shows it "[answered, no proof]" once the judge reads it so.
export function proofTargets(ledger, nowMs, turnId) {
  return openItems(ledger, nowMs).filter(i => needsProof(i) && i.answered && !i.proofAskedAt && !i.carried
    && (!turnId || i.answered.turnId === turnId))
}

export function proofPrompt(items) {
  const lines = items.map(i => `${i.id}. "${excerpt(i.text, 160)}"`)
  return [
    `${GATE_HEAD} ${items.length === 1 ? 'A brief from the lead reads as answered' : `${items.length} briefs from the lead read as answered`}, but a brief counts as done only with proof:`,
    ...lines,
    `Close each from Bash with ${CLI.close} and the proof that it is done (a PR number, commit or file path), or say what is still missing. (Asked once per brief; it will not be asked again.)`,
  ].join('\n')
}

export const markProofAsked = (ledger, ids, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (ids.includes(i.id) ? { ...i, proofAskedAt: nowMs } : i)),
})

// ── the agent's own hand: the tools ledger_close, ledger_drop, ledger_add ──────
//
// The judge reads the turn's text and never its work: it cannot see that a commit landed or a
// file was written, only whether the prose said so, and it costs a model call every turn that
// leaves anything open. The agent knows what it did. So the agent closes its own items as it
// finishes them, each with the proof that it is done, and the judge reads only what is still
// open after that (register.js, judgeTurn): a turn whose agent closed everything costs no call.
export const TOOL = { close: 'mcp__ghostfleet__ledger_close', drop: 'mcp__ghostfleet__ledger_drop', add: 'mcp__ghostfleet__ledger_add' }
// The same three from Bash, and the only form the reminders name. bin/fleet-ledger edits the
// same file through the same functions. A mod's tools are registered once, at session start,
// and in practice no session had them to call: measured over 14 days, agents closed items
// 3,305 times through fleet-ledger and 0 times through the tools, while every note (~15,800 of
// them, ~740 characters each) spelled out both. The tools' handlers stay, for a session that
// does have them; the words go.
export const CLI = { close: 'fleet-ledger close <id> "<proof>"', drop: 'fleet-ledger drop <id> "<reason>"', add: 'fleet-ledger add "<ask>"' }
const CLI_ANSWER = 'fleet-ledger answer <id> "<answer>"'
const CLI_EXPLAIN = 'fleet-ledger explain <id>'
export const PROOF = 240

// Open, and the dormant and retired states too: a stale promise whose work did land is
// closed with its proof like any other.
const CLOSABLE = new Set(['open', 'waiting', 'stale', 'expired'])
// Each answers { ledger, said }: `ledger` null when nothing changed, `said` what the agent
// reads back. A close needs proof, a drop a reason: an empty one is refused, not defaulted,
// since "closed, because I say so" is the judge's failure in the agent's hand.
function closeAs(ledger, id, state, field, why, { nowMs, turnId }) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  if (!it) return { ledger: null, said: `ledger: no item ${id}` }
  if (!CLOSABLE.has(it.state)) return { ledger: null, said: `ledger: item ${it.id} is already ${it.state}` }
  const closed = { ...it, state, closedAt: nowMs, closedBy: 'agent', [field]: excerpt(why, PROOF), ...(turnId ? { closedTurn: turnId } : {}),
    ...(it.source === QUESTION && state === 'done' ? { answer: { text: excerpt(why, 200), at: nowMs } } : {}) }
  return { ledger: { ...ledger, items: ledger.items.map(i => (i === it ? closed : i)) }, said: `ledger: ${it.id} ${state === 'done' ? 'closed' : 'dropped'}` }
}
export function closeByAgent(ledger, id, proof, ctx) {
  if (!oneLine(proof)) return { ledger: null, said: `ledger: ${id} not closed: proof is required (a path, link, commit, PR number or command result)` }
  return closeAs(ledger, id, 'done', 'proof', proof, ctx)
}
export function dropByAgent(ledger, id, reason, ctx) {
  if (!oneLine(reason)) return { ledger: null, said: `ledger: ${id} not dropped: a reason is required` }
  return closeAs(ledger, id, 'dropped', 'reason', reason, ctx)
}
// An ask the split missed joins the latest prompt's window, so the gate covers it too.
export function addByAgent(ledger, text, { nowMs, turnId }) {
  const t = excerpt(text)
  if (!t) return { ledger: null, said: 'ledger: nothing added: the text was empty' }
  const next = addItem(ledger, { text: t, at: nowMs, turnId, source: 'user', prompt: Number(ledger.prompt) || 0, by: 'agent', asIs: true })
  return { ledger: next, said: `ledger: tracking ${next.seq}` }
}

// The note a prompt carries to the model, never shown the person: what is open, by id, and
// the rule in one line. Requests first, newest first (the message just sent is the one most
// likely to be worked on), then promises; NOTE_ITEMS at most, each cut to NOTE_TEXT, so the
// note stays under NOTE_MAX characters however long the backlog grows (the worst case: eight
// items at the cut, four-digit ids, the count line; the note that named the tools too came to
// ~1,430 there); the rest is a count and /ledger. '' when nothing is open: a session with a
// clean ledger reads nothing extra.
// Owed items only (see owed): the message this note rides on is turn-scoped, and naming it
// told the agent to spend a tool call closing an instruction it was about to carry out.
// The rule line ends on the words it always ended on ("for an ask this list missed."), which
// is what REMINDER strips a quoted note by, old or new.
export const NOTE_ITEMS = 8
export const NOTE_TEXT = 100
export const NOTE_MAX = 1250
export const NOTE_HEAD = '[ghostfleet ledger: open items]'
export function contextNote(ledger, nowMs) {
  const open = owedItems(ledger, nowMs)
  if (!open.length) return ''
  const newest = (a, b) => Number(b.id) - Number(a.id)
  const req = open.filter(i => i.source !== 'promise').sort(newest)
  const prom = open.filter(i => i.source === 'promise').sort(newest)
  const shown = [...req, ...prom].slice(0, NOTE_ITEMS)
  const more = open.length - shown.length
  return [
    NOTE_HEAD,
    ...shown.map(i => `${i.id} ${i.source === 'promise' ? '(you said you would)' : '(asked)'}: ${excerpt(i.text, NOTE_TEXT)}`),
    ...(more > 0 ? [`+${more} more open (/ledger lists them)`] : []),
    `Close from Bash when done: ${CLI.close} (proof required: a commit, PR, path or command output); ${CLI.drop} if not a real ask or cancelled; ${CLI.add} for an ask this list missed.`,
  ].join('\n')
}

// ── what the session holds for the person ─────────────────────────────────────
//
// A `waiting` item is off the open list and off the note above (contextNote reads open
// items only), so nothing put it in front of the model again once the turn that asked had
// scrolled away, and nothing put it in front of the person at all outside the session:
// /ledger said "+N waiting on the person" as a count. Measured on one master: every quiet
// spell of two hours or more had nothing left it could do alone, and six of its eight
// outstanding items were waiting on the owner, each closed only after the owner wrote. The
// limit on an unattended run was how soon the owner saw those.
//
// heldItems() is what a status question asks the agent to put to the person (statusNote), one
// row per item. The phone and the briefing show only the first two kinds, the ones FOR YOU
// (forYouItems); the other two are the agent's to move, and listed there as the person's they
// were the agent's work handed back:
//   question  a question the agent asked them that they have not answered (turnQuestions)
//   waiting   a judged turn said it waits on the person (waitsOnPersonNote); `since` is when.
//             For the person, so no age limit (see FOR YOU); a lead's brief held on its
//             sender is listed within WAITING_EXPIRE_MS and BAND_DAYS, as before
//   replied   it was waiting and the person's message spoke to it (wakeWaiting): open again,
//             the agent's move now. Still listed, so a reply does not make the row vanish
//             before the agent has acted on it; it leaves when the agent closes or drops it.
//             (Not `answered`, which on an item is the judge's word for a brief it read as
//             done without proof; the person replying and the judge reading are two events)
//   open      a request (never a promise) nobody has touched in HELD_OPEN_MS: no turn
//             reported on it and nothing woke it. Four hours: a long turn, or a worker it
//             was handed to, legitimately holds a request for an hour or two with a report
//             on it, and a report restarts the clock (lastTouch). One untouched for twice
//             the two-hour quiet spell above was dropped or is blocked, and either way the
//             person is who can move it
// NOT a request the judge read as done that waits only for its proof (`answered`, needsProof).
// A brief that a lead delivered and the agent answered in prose stays open for its proof;
// listed after four hours it would hand the person something that waits on the agent, not on
// them. (The person's own messages from the phone were such briefs until they were marked as
// the owner's, deliverySource; one recorded before that is still `fleet`.)
// An item CARRIED to this session from a stopped worker (carryItems) is the session's own
// request now: it is listed by the same rules, untouched for four hours or waiting, and its
// row says where it came from (`from`, `was`, `note`) since its text is the worker's ask.
export const HELD_OPEN_MS = 4 * 3_600_000
// NOR the person's reply itself. A message that wakes a waiting item (wakeWaiting) is also an
// item of its own, made from the same prompt at the same instant (`woke` is its `at`). Listed,
// it is the same ask twice, the item as `replied` and the reply as `open` four hours on, and the
// second is the person's own words handed back to them.
// NOR an item still inside its turn (owed): nothing is held for the person mid-turn.
export function heldItems(ledger, nowMs) {
  const rows = []
  const replies = new Set(ledger.items.filter(i => i.woke).map(i => Number(i.woke)))
  const steps = holdersOf(ledger.items)
  for (const i of ledger.items) {
    // What waits on the person never ages off the list, once its turn settles: theirs, or the
    // agent's request they hold up (heldOnPerson). A step lives as long as its request (stepLive).
    const yours = forYou(i) && stepLive(i, steps, nowMs)
    if (!owed(i, nowMs) || (!yours && !(i.state === 'waiting' && owes(i)) && !fresh(i, nowMs))) continue
    if (i.state === 'open' && replies.has(Number(i.at)) && !i.woke) continue
    const step = i.via === 'step' && steps.get(i.id)
    const reason = step ? excerpt(`it unblocks ${step.id}: ${oneLine(step.text)}`, 160) : i.progress && i.progress.reason ? excerpt(i.progress.reason, 160) : ''
    const c = i.carried
    const came = c ? { from: String(c.from || ''), was: String(c.state || ''), ...(c.note ? { note: excerpt(c.note, 160) } : {}) } : {}
    const row = state => ({ id: i.id, text: excerpt(i.text), source: i.source, at: Number(i.at) || 0, state, reason, ...came })
    if (i.source === QUESTION) { if (yours) rows.push({ ...row(step ? 'waiting' : 'question'), since: Number(i.askedAgain) || Number(i.at) || 0, ...(i.n ? { n: Number(i.n) } : {}), ...(i.options ? { options: i.options } : {}) }); continue }
    if (i.state === 'waiting' && Array.isArray(i.awaits) && i.awaits.length) continue
    if (i.state === 'waiting' && !waitedOut(i, nowMs)) rows.push({ ...row('waiting'), since: Number(i.progress && i.progress.at) || Number(i.at) || 0 })
    else if (i.state === 'open' && i.woke) rows.push({ ...row('replied'), since: Number(i.woke) })
    else if (i.state === 'open' && i.source !== 'promise' && !i.answered && nowMs - lastTouch(i) >= HELD_OPEN_MS) rows.push({ ...row('open'), since: lastTouch(i) })
  }
  return rows.sort((a, b) => a.since - b.since || Number(a.id) - Number(b.id))
}

// THE PERSON ASKING FOR STATUS. Short messages only, and the status word has to be what is
// asked about: "whats the status", "status?", "any update?", "qué falta", "cómo vamos". A
// request that merely names a status ("fix the status bar", "the status file is torn") is
// work, not a status question, and must not have the agent stop to recite its ledger.
const STATUS_MAX = 120
const STATUS_ASKS = [
  /^(?:so\s+|ok\s+|and\s+|hey\s+)?(?:what'?s|whats|what\s+is|how'?s|hows)\s+(?:the\s+|our\s+|your\s+)?(?:status|state\s+of\s+(?:things|play)|progress|situation)\b/i,
  /^status\s*(?:[?!.]|$|update|report|check|pls|please|of\b|on\b)/i,
  /\b(?:what'?s|whats|what\s+is)\s+(?:left|pending|outstanding|blocking|missing)\b/i,
  /\bwhat\s+(?:remains|is\s+left)\b/i,
  /\bwhere\s+(?:are\s+we|do\s+we\s+stand|are\s+things)\b/i,
  /\bhow'?s\s+it\s+going\b|\bhow\s+is\s+it\s+going\b|\bhow\s+are\s+things\b/i,
  /^(?:any\s+)?(?:updates?|progress)\s*\?/i,
  /\bwhat\s+do\s+you\s+need\s+from\s+me\b|\banything\s+(?:for|from)\s+me\b|\bwaiting\s+on\s+me\b/i,
  /\bqu[eé]\s+(?:falta|queda|hay\s+pendiente)\b/i,
  /\bc[oó]mo\s+(?:va|vamos|vas|van)\b|\ben\s+qu[eé]\s+(?:estamos|vamos|va)\b/i,
  /^(?:y\s+)?(?:el\s+)?estado\s*(?:[?¿]|$)/i,
  /\bqu[eé]\s+necesitas\s+de\s+m[ií]\b/i,
]
export function isStatusQuestion(text) {
  const t = requestText(text).replace(/^¿\s*/, '')
  if (!t || t.length > STATUS_MAX || isNudge(text)) return false
  return STATUS_ASKS.some(re => re.test(t))
}

// The note a status question carries beside contextNote: every held item, with what the
// agent last said it needs, and the instruction to put each one to the person as a
// question. '' when nothing is held, so a status answer with nothing owed reads as before.
export const STATUS_HEAD = '[ghostfleet ledger: waiting on the person]'
export const STATUS_ITEMS = 12
export function statusNote(ledger, nowMs) {
  const held = heldItems(ledger, nowMs)
  if (!held.length) return ''
  const shown = held.slice(0, STATUS_ITEMS)
  const word = { question: 'you asked them', waiting: 'waiting on them', replied: 'they replied, yours to finish', open: 'open, untouched' }
  return [
    STATUS_HEAD,
    'The person just asked for status. These items are held for them:',
    ...shown.map(i => `${i.id} (${word[i.state]} ${ago(nowMs - i.since)}): ${excerpt(i.text, NOTE_TEXT)}${i.reason ? ` — you said: ${excerpt(i.reason, 100)}` : ''}${i.from ? ` — carried from ${i.from}, stopped while ${i.was}` : ''}`),
    ...(held.length > shown.length ? [`+${held.length - shown.length} more (/ledger all lists them)`] : []),
    'Your status answer must include every one of these, by id, and ASK the person about each one: one direct question per item, saying what you need from them to move it. For one they already replied to, say what you did with the reply, or close it. Do not fold them into a summary line.',
  ].join('\n')
}

// Everything a prompt carries to the model, in order: the open items, then (on a status
// question) what is held for the person. register.js's prompt.submit hands this over whole.
export function promptNotes(ledger, text, nowMs) {
  const notes = [contextNote(ledger, nowMs)]
  if (isStatusQuestion(text)) notes.push(statusNote(ledger, nowMs))
  return notes.filter(Boolean)
}

// By hand: `fleet-ledger close <id>` and `/ledger close <id>`. null when there is no such
// open item.
export function closeByHand(ledger, id, nowMs) {
  const it = ledger.items.find(i => i.id === String(id))
  if (!it || !CLOSABLE.has(it.state)) return null
  return {
    ...ledger,
    items: ledger.items.map(i => (i === it ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'person' } : i)),
  }
}

// A RETIRED WORKER'S UNFINISHED ITEMS GO TO ITS LEAD. fleet-stop kills the session and clears
// every file the fleet keeps about it except this one, so whatever it still owed sat in a
// ledger nobody would open again: measured on one fleet, 117 unfinished items across 280
// worker ledgers, 100 of them over a day old, while the lead the person talks to saw none.
// Each open, waiting or not-done item (`stale` is a promise nobody took up, and `expired` is
// already retired) becomes an open item of the lead's, `[<worker>] <ask>`, keeping where it
// came from and its last word (`carried`); the lead finishes it, re-dispatches it or drops it
// with the ordinary tools. In the worker's file it is `carried`, with the lead's id, so a
// second stop finds nothing to carry and the measurement above stops counting it.
//   Dated NOW, not when it was asked: an item 12 days old would be past BAND_DAYS on arrival,
// off the lead's open list and its note, which is where it already was. And no `prompt`: the
// gate re-prompts only items of the lead's own latest prompt window, and a stop between two of
// its turns is not something that turn was asked.
//   `branch` and `pr`, when the stop knew them: the worker's branch and the number of its OPEN
// PR. They ride on `carried`, so that PR merging later closes the item (closeLanded) without
// anyone reading it again. A worker whose PR had ALREADY merged carries nothing (closeMerged).
export const CARRIED = new Set(['open', 'waiting', 'not-done'])
export function carryItems(worker, lead, { from, sessionId = '', to = 'master', nowMs, branch = '', pr = '' }) {
  const sid = String(sessionId)
  const already = new Set(lead.items.filter(i => i.carried && i.carried.sessionId === sid).map(i => i.carried.id))
  const owed = worker.items.filter(i => CARRIED.has(i.state) && !already.has(i.id))
  if (!owed.length) return null
  let next = lead
  const moved = new Map()
  for (const i of owed) {
    const note = (i.progress && i.progress.reason) || i.reason || ''
    // Always `fleet`, a worker's promise too: as a promise it would be the lead's own word
    // ("(you said you would)"), go stale on the lead's turns and close over PROMISE_CAP.
    next = addItem(next, { text: excerpt(`[${from}] ${i.text}`), at: nowMs, source: 'fleet', asIs: true })
    const it = next.items[next.items.length - 1]
    const carried = {
      from, sessionId: sid, id: i.id, state: i.state, source: i.source, at: i.at, ...(note ? { note: excerpt(note) } : {}),
      ...(branch ? { branch: String(branch) } : {}), ...(/^\d+$/.test(String(pr)) ? { pr: Number(pr) } : {}),
    }
    next = { ...next, items: next.items.map(x => (x === it ? { ...x, carried } : x)) }
    moved.set(i.id, it.id)
  }
  return { lead: next, worker: markCarried(worker, moved, { to, nowMs }), ids: [...moved.values()] }
}
// The worker's side: each item in `moved` (its id -> the lead's) is `carried`, and says where.
export function markCarried(worker, moved, { to, nowMs }) {
  return {
    ...worker,
    items: worker.items.map(i => (moved.has(i.id) && CARRIED.has(i.state)
      ? { ...i, state: 'carried', closedAt: nowMs, closedBy: 'fleet-stop', carriedTo: { session: to, id: moved.get(i.id) }, reason: `carried to ${to} as ${moved.get(i.id)}` }
      : i)),
  }
}

// A SESSION THAT WENT ON UNDER ANOTHER PROFILE TAKES WHAT IT OWES WITH IT. A ledger is filed
// under the session's id in the fleet dir the session runs under, and a conversation can be
// resumed under another profile: its transcript copied into that profile's projects dir and
// reopened there, where the mod writes <that profile's fleet dir>/<same id>.ledger. Measured:
// 16 session ids with a ledger in two profiles' fleet dirs. In 13 the newer file began as a
// copy of the older one (the same items, by id and time; 7 of them byte-identical to the
// millisecond, a time-preserving copy taken with the transcript), and in 3 the newer one
// started empty beside it. Either way the file the session stopped writing to was never read
// again: in 9 of the 16 it still held open, waiting or not-done items, which nobody would see. The copy is made
// outside ghostfleet, so the fix is where every path meets: the mod, when the session starts
// under a fleet dir, asks every OTHER profile's fleet dir for a file of its own id.
//   Each item owed there (CARRIED's states) that this ledger does not already hold, by its
// time, source and words, is added here with its state as it was (`movedFrom`), and one this
// ledger holds as `moved` (the session went there and came back) is that item again. In the
// old file each becomes `moved`, with where it went (`movedTo`): no open item is left behind,
// and a second start finds nothing to move. Its history stays; nothing is deleted. Written
// here FIRST and there after, so a failure between the two leaves an item in both files,
// never in neither, and the next start finds it here and only marks it there.
//   Not `carried`: the item is still this session's own, so it keeps its source, its age and
// its proof rule, and is not handed to anybody.
const MOVE_KEY = i => `${Number(i.at) || 0}|${i.source || ''}|${normAsk(i.text)}`
export function adoptLedger(here, old, { from, to, nowMs }) {
  const owed = old.items.filter(i => CARRIED.has(i.state))
  if (!owed.length) return null
  const mine = new Map(here.items.map(i => [MOVE_KEY(i), i]))
  let next = here
  const moved = new Map()
  let added = 0
  let back = 0
  for (const i of owed) {
    const h = mine.get(MOVE_KEY(i))
    if (h) {
      if (h.state === 'moved') {
        const { closedAt, closedBy, reason, movedTo, ...rest } = h
        next = { ...next, items: next.items.map(x => (x === h ? { ...rest, state: i.state, ...(i.progress ? { progress: i.progress } : {}) } : x)) }
        back++
      }
      moved.set(i.id, h.id)
      continue
    }
    // Its old prompt number counts another file's prompts, and an inTurn mark belongs to a
    // turn of a process that is gone: both dropped, so it is owed and never re-gated.
    const { id, prompt, inTurn, ...rest } = i
    next = addItem(next, { text: i.text, at: i.at, source: i.source, asIs: true })
    const it = next.items[next.items.length - 1]
    next = { ...next, items: next.items.map(x => (x === it ? { ...rest, id: it.id, movedFrom: { dir: from, id } } : x)) }
    moved.set(i.id, it.id)
    added++
  }
  const left = {
    ...old,
    items: old.items.map(i => (moved.has(i.id) && CARRIED.has(i.state)
      ? { ...i, state: 'moved', closedAt: nowMs, closedBy: 'fleet', movedTo: { dir: to, id: moved.get(i.id) }, reason: `moved with its session to ${to}` }
      : i)),
  }
  return { here: added || back ? next : null, old: left, added, back, moved: moved.size }
}

// A WORKER WHOSE PR MERGED OWES NOTHING. Carried, its items were the lead's to prove all over
// again: measured, 23 carried items sat open in one lead's ledger, many for work already
// merged or moved elsewhere, each `fleet` and so done only with proof the lead did not have to
// hand. The merge IS the proof, and fleet-stop already asks for it (the same answer fleet-clean
// and the inbox footer give). So each open or waiting item closes as `done` with proof
// "PR #N merged", by `fleet-stop`, and none is carried. A not-done item stays not-done: the
// turn said why it was not done, and a merge does not say otherwise.
export function closeMerged(worker, { pr, nowMs }) {
  const n = Number(pr)
  if (!Number.isInteger(n) || n <= 0) return null
  const owed = worker.items.filter(i => i.state === 'open' || i.state === 'waiting')
  if (!owed.length) return null
  return {
    ...worker,
    items: worker.items.map(i => (owed.includes(i)
      ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'fleet-stop', proof: `PR #${n} merged` } : i)),
  }
}

// A CARRIED ITEM CLOSES WHEN ITS WORKER'S WORK LANDS. A worker stopped with its PR still open
// carried its items to the lead; the PR merging later is that proof, and nobody had to read the
// item again to see it. `prs` is fleet-merged --prs as rows { branch, number, state }. An item
// that carried its open PR's number closes when that number is MERGED; one that carried only a
// branch, when the branch has a MERGED PR and no OPEN one (an open PR is the work still in
// flight, as fleet-shipped reads it). Asked where the lead already reads merges for free
// (fleet-inbox): no model call, and a cached answer at most ten minutes old. Not retroactive:
// an item carried before `branch` was kept has none, and only a person or lead clears it
// (dropCarried).
export function closeLanded(lead, prs, { nowMs }) {
  const rows = (prs || []).filter(r => r && r.branch)
  const landed = i => {
    const c = i.carried
    if (!c || !CLOSABLE.has(i.state)) return 0
    if (c.pr) return rows.some(r => Number(r.number) === Number(c.pr) && r.state === 'MERGED') ? Number(c.pr) : 0
    if (!c.branch) return 0
    const mine = rows.filter(r => r.branch === c.branch)
    if (mine.some(r => r.state === 'OPEN')) return 0
    const m = mine.find(r => r.state === 'MERGED')
    return m ? Number(m.number) || 0 : 0
  }
  const shut = new Map(lead.items.map(i => [i.id, landed(i)]).filter(([, n]) => n))
  if (!shut.size) return null
  return {
    ...lead,
    items: lead.items.map(i => (shut.has(i.id)
      ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'fleet', proof: `PR #${shut.get(i.id)} merged` } : i)),
  }
}

// `fleet-ledger drop-carried <worker> "<reason>"`: every item still owed that was carried from
// that worker, dropped with one reason. The person's or the lead's call, never automatic: what
// a stopped worker left can be work nobody else holds, and only someone who read it knows.
export function dropCarried(ledger, from, reason, { nowMs }) {
  const who = String(from || '').trim()
  if (!who) return { ledger: null, said: 'ledger: drop-carried needs the worker\'s name' }
  if (!oneLine(reason)) return { ledger: null, said: `ledger: nothing dropped: a reason is required` }
  const hit = ledger.items.filter(i => i.carried && i.carried.from === who && CLOSABLE.has(i.state))
  if (!hit.length) return { ledger: null, said: `ledger: nothing carried from ${who} is still owed` }
  const why = excerpt(reason, PROOF)
  return {
    ledger: { ...ledger, items: ledger.items.map(i => (hit.includes(i) ? { ...i, state: 'dropped', closedAt: nowMs, closedBy: 'agent', reason: why } : i)) },
    said: `ledger: dropped ${hit.length} item${hit.length === 1 ? '' : 's'} carried from ${who} (${hit.map(i => i.id).join(', ')})`,
  }
}

// `clear` closes every open item by hand; the history stays in the file.
export const clearOpen = (ledger, nowMs) => ({
  ...ledger,
  // what the agent owes, never a question to the person: clearing the agent's list answers nothing
  items: ledger.items.map(i => (i.state === 'open' && i.source !== QUESTION ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'person' } : i)),
})

const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

// The listing both the CLI and /ledger print. The plain list is what the band counts (owed);
// an item still inside its turn is a count under it, and `all` lists it, marked.
export function listing(ledger, nowMs, { all = false } = {}) {
  // A request held on the person is still the agent's (FOR YOU): listed here as waiting, with the
  // for-you items it waits on, and never among them.
  const owedNow = all ? [] : owedItems(ledger, nowMs)
  const rows = all ? ledger.items : [...owedNow, ...ledger.items.filter(i => i.state === 'waiting' && i.source !== QUESTION && owed(i, nowMs) && fresh(i, nowMs))]
  const yours = all ? [] : forYouItems(ledger, nowMs)
  const inTurn = all ? 0 : openItems(ledger, nowMs).length - owedNow.length
  const opts = r => (r.options ? `  [${r.options.map(o => `${o.key}) ${excerpt(o.text, 30)}`).join(' ')}]` : '')
  const waits = [
    ...(inTurn ? [`+${inTurn} in the turn answering ${inTurn === 1 ? 'it' : 'them'}, owed only if not done there (all lists them)`] : []),
    ...(yours.length ? [`for you (${yours.length}): answer by number in the chat, or ${CLI_ANSWER}; ${CLI_EXPLAIN} asks the session to explain one`,
      ...yours.map(r => `${r.id.padStart(3)}  ${r.state.padEnd(8)} ${(r.n ? `#${r.n}` : '').padEnd(7)} ${ago(nowMs - r.since).padStart(4)}  ${excerpt(r.text, 100)}${opts(r)}${r.reason ? `  (${excerpt(r.reason, 60)})` : ''}${r.explain && r.explain.text ? '  [explained]' : r.explain && r.explain.failed ? '  [explain failed]' : r.explain ? '  [explain asked]' : ''}`)] : []),
  ]
  const j = ledger.judge
  const judged = !j ? [] : [j.ok
    ? `last judge: ok${j.items ? `, ${j.items} item${j.items === 1 ? '' : 's'} in ${j.calls || 1} call${(j.calls || 1) === 1 ? '' : 's'}` : ''} (${ago(nowMs - j.at)} ago)`
    : `last judge: FAILING, failed open: ${j.why} (${ago(nowMs - j.at)} ago)`]
  if (!rows.length) return [all ? 'ledger: empty' : 'ledger: nothing open', ...waits, ...judged].join('\n')
  const out = rows.map(i => {
    const tag = i.source === 'promise' ? 'promise' : i.source
    const by = i.state !== 'open' && i.closedBy ? `${i.closedBy === 'hand' ? 'person' : i.closedBy}: ` : ''
    const said = i.proof || i.reason
    const why = said || by ? `  (${by}${said ? excerpt(said, 80) : ''})`.replace(': )', ')') : ''
    const working = i.state === 'open' && i.progress ? `  [in progress${i.progress.reason ? `: ${excerpt(i.progress.reason, 60)}` : ''}]` : ''
    const c = i.state === 'open' && i.carried
    const came = c ? `  [${c.from} stopped; it was ${c.state}${c.note ? `: ${excerpt(c.note, 60)}` : ''}]` : ''
    const unproven = i.state === 'open' && i.answered ? '  [answered, no proof]' : ''
    const turn = i.state === 'open' && !owed(i, nowMs) ? '  [this turn]' : ''
    const held = !all && i.state === 'waiting' ? `  [waits on ${Array.isArray(i.awaits) && i.awaits.length ? `you: ${i.awaits.join(', ')}` : i.source === 'fleet' ? 'its sender' : 'you'}]` : ''
    return `${i.id.padStart(3)}  ${i.state.padEnd(8)} ${tag.padEnd(7)} ${ago(nowMs - i.at).padStart(4)}  ${excerpt(i.text, 100)}${i.gated ? '  [gated]' : ''}${working}${came}${unproven}${turn}${held}${why}`
  })
  return [...out, ...waits, ...judged].join('\n')
}

// The band's ledger row as text runs, the longest form that fits `columns`:
//   ledger · 2 open · oldest 4m "fix the login redirect…" · promise: merge when green
// What is FOR the person is its own count beside the agent's, never folded into it, and it
// stays at every width: "ledger · 3 open" over a turn that ended on twenty questions to the
// person was the band saying there was nothing for them.
//   ledger · 5 open · 20 for you · oldest 4m "fix the login redirect…" · promise: merge when green
// Narrower, the quote goes, then the promise's words, then everything but the counts. A judge
// whose last call failed says so first, at every width: a failing judge closes nothing, and
// a count that only grows was all the band showed of it.
//   ledger · judge failing: reply was not the JSON asked for · 24 open · …
export const LEDGER_COLOR = { open: '#ffd75f', promise: '#87afd7', failing: '#ff5f5f', forYou: '#5fd7ff' }
export function ledgerRuns(s, nowMs, columns) {
  if (!s || (!s.open && !s.promises && !s.judgeFailing && !s.forYou)) return null
  const cols = Math.max(1, Number(columns) || 80)
  const sep = { text: ' · ', dim: true }
  const head = { text: 'ledger', dim: true }
  const open = s.open ? { text: `${s.open} open`, color: LEDGER_COLOR.open, bold: true } : null
  const yours = s.forYou ? { text: `${s.forYou} for you`, color: LEDGER_COLOR.forYou, bold: true } : null
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
    s.forYou ? { ...yours, text: `${s.forYou}?` } : null,
    s.promises ? { text: `${s.promises}◇`, color: LEDGER_COLOR.promise } : null,
  ]
  const forms = [
    [head, fail(60), open, yours, quote(48), prom(40)],
    [head, fail(40), open, yours, quote(24), prom(24)],
    [head, fail(24), open, yours, s.oldest ? { text: `oldest ${age}`, dim: true } : null, prom(0)],
    [head, fail(0), open, yours, prom(0)],
    [fail(0), open, yours, prom(0)],
    tiny,
    tiny.filter(Boolean).slice(0, 2),
    [tiny.find(Boolean)],
  ]
  let runs = null
  for (const parts of forms) {
    runs = parts.filter(Boolean).flatMap((r, i) => (i ? [sep, r] : [r]))
    if (runs.reduce((k, r) => k + [...r.text].length, 0) <= cols) return runs
  }
  return runs
}

// ── what one write changed, for the fleet's memory (docs/MEMORY.md) ─────────
// An item that was not there before (opened) and an item whose state moved (waiting, closed
// one of the ledger's ways, opened again). Made where each write is made — the mod's
// applyLedger, fleet-ledger, lib/ledger-landed.mjs, lib/ledger-carry.mjs — so the memory
// never has to watch the files, and spelled once, here, because the mod can import only
// this directory and lib/ can import it too. `t` is the ledger's own time for the change:
// when the item was asked, or closed. `for` is its direction (forYou): "you" for what waits on
// the person, "model" for what the agent owes, decided here once so that the briefing, which
// reads the memory and never a ledger file, says WAITING ON THE OWNER by the same rule as the
// band and the phone.
// WHAT THE OWNER ANSWERED, read off one ledger, so a live write and a backfill spell it the same.
// Each is an answer the ledger can show was given to a question, and nothing weaker:
//   a bare reply to a numbered question (foldReply), from the person: its `source` says so, and
//     `asked` is the question. One from before replies carried those is not an answer to anything
//     on record: "1" says nothing without what it picked, and the item's own text is the person's
//     ask, not a question put to them. Measured on one machine: every such reply was a bare digit,
//     and printed against that text they would have read as the owner's decisions on every
//     briefing and meant nothing. They are counted (unaskedReplies), not guessed at
//   a whole message, the next thing the person said after a numbered question (addPrompt)
//   a lead's QUESTION that waited on the person, woken by a message of theirs
//   a question the agent asked them (QUESTION), answered by its number, by the phone's option
//     button, or closed by the agent with their words (settleQuestions, answerItem, closeAs)
// NOT ANY OTHER WAKE. A wake is two shared words (mentions, loose), which is right for "the person
// may have moved" and wrong for "the person decided". Measured on one log: 34 wakes by the person,
// none of them passing the strict reading, one with a question in it, and most of them a follow-up
// on the same subject. A decision from the owner never decays, so a wrong one stays on every
// briefing, and that is worse than one that was never recorded.
// A reply of the person's whose question the ledger never held. A lead's "2" to a worker folds the same
// way, so one with no source counts as the person's only on the person's own item.
export function unaskedReplies(ledger) {
  let n = 0
  for (const i of (ledger && ledger.items) || []) {
    for (const r of i.replies || []) if ((r.source ? r.source === 'user' : i.source === 'user') && !r.asked) n++
  }
  return n
}
export function ownerAnswers(ledger) {
  const items = (ledger && ledger.items) || []
  const out = []
  for (const i of items) {
    for (const r of i.replies || []) {
      if (r.source === 'user' && r.asked) out.push({ id: String(i.id), t: Number(r.at) || 0, answer: r.text, question: r.asked, how: 'reply' })
    }
    if (i.asked && i.source === 'user') out.push({ id: String(i.id), t: Number(i.at) || 0, answer: i.text, question: i.asked, how: 'reply' })
    if (i.source === QUESTION && i.answer && i.answer.text) out.push({ id: String(i.id), t: Number(i.answer.at) || Number(i.closedAt) || 0, answer: i.answer.text, question: i.text, how: 'question' })
    if (i.woke && i.source === 'fleet' && String(i.text || '').includes('?')) {
      const by = items.find(x => x !== i && x.source === 'user' && Number(x.at) === Number(i.woke))
      if (by) out.push({ id: String(i.id), t: Number(i.woke) || 0, answer: by.text, question: i.text, how: 'woke' })
    }
  }
  return out.filter(a => a.t && a.answer && a.question)
}
export function ledgerChanges(before, after) {
  const was = new Map(((before && before.items) || []).map(i => [String(i.id), i]))
  const out = []
  for (const i of (after && after.items) || []) {
    const o = was.get(String(i.id))
    const dir = forYou(i) ? 'you' : 'model'
    if (!o) out.push({ op: 'open', id: String(i.id), text: i.text, source: i.source, state: i.state, for: dir, t: Number(i.at) || 0 })
    else if (o.state !== i.state) {
      out.push({ op: 'state', id: String(i.id), text: i.text, state: i.state, proof: i.proof, reason: i.reason,
                 by: i.closedBy, for: dir, t: Number(i.closedAt || i.expiredAt) || 0 })
    }
  }
  const told = new Set(ownerAnswers(before).map(a => `${a.id}/${a.t}`))
  for (const a of ownerAnswers(after)) if (!told.has(`${a.id}/${a.t}`)) out.push({ op: 'answer', ...a })
  return out
}
