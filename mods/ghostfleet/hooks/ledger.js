// The request ledger's vocabulary, as plain functions: no `$`, no I/O. The LEDGER section
// of register.js uses them; bin/fleet-ledger reads and writes the same file through them,
// and test/run.sh imports this file with node.
//
// <fleet dir>/<session_id>.ledger   (JSON, but deliberately NOT named *.json: eight readers
//                                    glob <fleet dir>/*.json as status records)
//   { v: 1, seq, prompt, window, items: [ { id, text, at, turnId, state, source, ... } ], judge? }
//
//   state    open | done | not-done | stale (a promise no judged turn addressed, see STALE_TURNS)
//            | dropped (the agent said it was not a real ask, or the person cancelled it)
//   source   user     typed at the prompt (or the phone's bridge), idle or mid-turn
//            fleet    a prompt fleet-send handed to the mod (DELIVERY)
//            promise  a commitment the agent made in a final message ("I'll merge when green")
//   gated    true once the gate has re-prompted about it: at most once per item, ever
//   progress { at, turnId, reason }: a judged turn reported the item's state and said the
//            work goes on elsewhere (a worker, a build, CI) or waits on the person. It stays
//            open, listed and judged, and the gate never names it (gateTargets)
//   queued   typed over a running turn; interrupted: its turn was stopped (Esc). Either may
//            never have reached the model, and the gate asks the transcript first
//   prompt   the number of the prompt that made it (ledger.prompt counts them); `window` is
//            the first prompt of the latest one, and only items from `window` on are gated.
//            An item from before this field existed has none, and is never gated again
//   closedBy agent (ledger_close / ledger_drop, with `proof` or `reason`) | judge |
//            person (/ledger close, fleet-ledger close; `hand` in a file written before)

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
  /\[ghostfleet ledger: open items\][\s\S]*?(?:for an ask this list missed\.|$)/g,
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
export function addPrompt(ledger, { text, at, turnId, source, queued, whole = false }, ids = []) {
  const asks = whole ? [requestItem(text)].filter(Boolean) : requestAsks(text)
  if (!asks.length) return null
  const prompt = (Number(ledger.prompt) || 0) + 1
  const window = queued && ledger.window ? ledger.window : prompt
  let next = { ...ledger, prompt, window }
  for (const ask of asks) {
    next = addItem(next, { text: ask, at, turnId, source, queued, prompt, asIs: true })
    ids.push(next.items[next.items.length - 1].id)
  }
  return next
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
export function addItem(ledger, { text, at, turnId, source, queued, prompt, by, asIs }) {
  const seq = (Number(ledger.seq) || 0) + 1
  const words = asIs ? String(text) : source === 'promise' ? excerpt(text) : requestItem(text)
  const item = {
    id: String(seq), text: words, at, ...(turnId ? { turnId } : {}), state: 'open', source,
    ...(queued ? { queued: true } : {}), ...(prompt ? { prompt } : {}), ...(by ? { addedBy: by } : {}),
  }
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
export function judgePrompt(items, turn, { promises, earlier = [], openPromises = [] }) {
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
    '- "done" also, with reason "reported: waiting on <what>", when the agent did everything the item asks of it and says plainly that only something outside its control remains (a registry or deploy propagating, a review) with nothing more for the agent to do.',
    '- "in-progress": the turn reports THIS item\'s current state and says the work is still going on elsewhere or waits on something, with a step still owed after it. E.g. "dry run done; the build is running in a worker, I\'ll ship it when it lands", "CI is running on the PR", "waiting on your pick between A and B". Work the agent could do now and simply did not is not this: it is "open".',
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
        'A promise is something the AGENT will do. What it asks the PERSON to do is never a promise: "you run X", "type X", "waiting on you", and every line of a list under "still waiting on you" or "for you to do". If you list one anyway, mark it "by":"person".',
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
    '',
    'Reply with ONLY this JSON, no prose, no code fence:',
    `{"items":[{"id":"<id>","status":"done|in-progress|not-done|open","reason":"<at most 12 words>"}],"waitingOnPerson":false,"promises":[${promises === 'off' ? '' : '{"text":"<at most 12 words>","by":"agent|person","same":"<open promise or in-progress item id, or empty>"}'}]}`,
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
  // one the judge says is the PERSON's to do is not a promise at all.
  const promises = (Array.isArray(v.promises) ? v.promises : [])
    .map(p => (p && typeof p === 'object' ? p : { text: p }))
    .filter(p => String(p.by || 'agent').toLowerCase() !== 'person')
    .map(p => ({ text: excerpt(p.text, 120), ...(p.same ? { same: String(p.same) } : {}) }))
    .filter(p => p.text && !addressedToPerson(p.text) && !waitsOnPerson(p.text)).slice(0, 3)
  return { items, promises, waitingOnPerson: v.waitingOnPerson === true, ...(partial ? { partial: true } : {}) }
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

// The verdict applied: judged items close, promises join as items of their own. A promise
// the judge says restates an open one (`same`), or that reads as one (samePromise), is that
// promise, never a second; its newer words replace the older ones only when the judge said so.
// An item judged in-progress stays open and carries `progress`, which the gate reads: it is
// being worked, and naming it again only gets the same report back. A promise whose words
// are the follow-through of such an item ("ship it when the worker lands") is that item.
export function applyVerdict(ledger, verdict, { nowMs, turnId, promises }) {
  const by = new Map(verdict.items.map(i => [i.id, i]))
  let next = {
    ...ledger,
    items: ledger.items.map(i => {
      const v = by.get(i.id)
      if (!v || i.state !== 'open') return i
      // Not a turn that ignored it, so it does not count towards a promise going stale.
      if (v.status === 'in-progress') return { ...i, progress: { at: nowMs, ...(turnId ? { turnId } : {}), ...(v.reason ? { reason: v.reason } : {}) } }
      if (v.status === 'open') {
        if (i.source !== 'promise') return i
        const kept = (Number(i.keptOpen) || 0) + 1
        return kept < STALE_TURNS ? { ...i, keptOpen: kept }
          : { ...i, keptOpen: kept, state: 'stale', closedAt: nowMs, closedBy: 'judge', reason: `no turn addressed it in ${kept} judged turns` }
      }
      return { ...i, state: v.status, closedAt: nowMs, closedBy: 'judge', ...(v.reason ? { reason: v.reason } : {}) }
    }),
  }
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
  return openItems(ledger, nowMs).filter(i => !i.gated && !i.progress && from && Number(i.prompt) >= from
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
export const lastGateAt = ledger => Math.max(0, ...ledger.items.map(i => Number(i.gatedAt) || 0))
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
    `${GATE_HEAD} ${items.length === 1 ? 'One request is' : `${items.length} requests are`} still open from this session:`,
    ...lines,
    `Finish each one now and close it with ${TOOL.close} and its proof, or say for each that it is not done and why (${TOOL.drop} if it was not a real ask). (Asked once per item; it will not be asked again.)`,
  ].join('\n')
}

export const markGated = (ledger, ids, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (ids.includes(i.id) ? { ...i, gated: true, gatedAt: nowMs } : i)),
})

// ── the agent's own hand: the tools ledger_close, ledger_drop, ledger_add ──────
//
// The judge reads the turn's text and never its work: it cannot see that a commit landed or a
// file was written, only whether the prose said so, and it costs a model call every turn that
// leaves anything open. The agent knows what it did. So the agent closes its own items as it
// finishes them, each with the proof that it is done, and the judge reads only what is still
// open after that (register.js, judgeTurn): a turn whose agent closed everything costs no call.
export const TOOL = { close: 'mcp__ghostfleet__ledger_close', drop: 'mcp__ghostfleet__ledger_drop', add: 'mcp__ghostfleet__ledger_add' }
export const PROOF = 240

// Each answers { ledger, said }: `ledger` null when nothing changed, `said` what the agent
// reads back. A close needs proof, a drop a reason: an empty one is refused, not defaulted,
// since "closed, because I say so" is the judge's failure in the agent's hand.
function closeAs(ledger, id, state, field, why, { nowMs, turnId }) {
  const it = ledger.items.find(i => i.id === String(id ?? '').trim())
  if (!it) return { ledger: null, said: `ledger: no item ${id}` }
  if (it.state !== 'open') return { ledger: null, said: `ledger: item ${it.id} is already ${it.state}` }
  const closed = { ...it, state, closedAt: nowMs, closedBy: 'agent', [field]: excerpt(why, PROOF), ...(turnId ? { closedTurn: turnId } : {}) }
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
// the rule. Requests first, newest first (the message just sent is the one most likely to be
// worked on), then promises; NOTE_ITEMS at most, each cut to NOTE_TEXT, so the note stays
// under ~1.5k characters however long the backlog grows; the rest is a count and /ledger.
// '' when nothing is open: a session with a clean ledger reads nothing extra.
export const NOTE_ITEMS = 8
export const NOTE_TEXT = 100
export const NOTE_HEAD = '[ghostfleet ledger: open items]'
export function contextNote(ledger, nowMs) {
  const open = openItems(ledger, nowMs)
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
    `When one is finished, call ${TOOL.close} with its id and the proof (a path, link, commit, PR number or command result). ${TOOL.drop} with a reason if it is not a real ask or the person cancelled it; ${TOOL.add} for an ask this list missed.`,
  ].join('\n')
}

// By hand: `fleet-ledger close <id>` and `/ledger close <id>`. null when there is no such
// open item.
export function closeByHand(ledger, id, nowMs) {
  const it = ledger.items.find(i => i.id === String(id))
  if (!it || it.state !== 'open') return null
  return {
    ...ledger,
    items: ledger.items.map(i => (i === it ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'person' } : i)),
  }
}

// `clear` closes every open item by hand; the history stays in the file.
export const clearOpen = (ledger, nowMs) => ({
  ...ledger,
  items: ledger.items.map(i => (i.state === 'open' ? { ...i, state: 'done', closedAt: nowMs, closedBy: 'person' } : i)),
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
    const by = i.state !== 'open' && i.closedBy ? `${i.closedBy === 'hand' ? 'person' : i.closedBy}: ` : ''
    const said = i.proof || i.reason
    const why = said || by ? `  (${by}${said ? excerpt(said, 80) : ''})`.replace(': )', ')') : ''
    const working = i.state === 'open' && i.progress ? `  [in progress${i.progress.reason ? `: ${excerpt(i.progress.reason, 60)}` : ''}]` : ''
    return `${i.id.padStart(3)}  ${i.state.padEnd(8)} ${tag.padEnd(7)} ${ago(nowMs - i.at).padStart(4)}  ${excerpt(i.text, 100)}${i.gated ? '  [gated]' : ''}${working}${why}`
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
