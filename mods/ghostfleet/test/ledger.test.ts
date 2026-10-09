// The LEDGER section against the engine (`claude plugin test mods/ghostfleet`): every
// request becomes an item, one judge call per answered turn closes what the final text
// addressed, and what is left gets ONE re-prompt, never a second, never after an Esc.
import { test, expect, mock } from 'claude-code/testing'

const DIR = '/fleet'
const ID = 'sess-1'
const FILE = `${DIR}/${ID}.json`
const LEDGER = `${DIR}/${ID}.ledger`
const SPOOL = `${DIR}/${ID}.handoff`
const BASE = { session_id: ID, sock: 'cf-acme-api', slot: 'w1', status: 'idle', ts: 1, cwd: '/w/acme-api' }

type Judge = (prompt: string, call?: any) => any
type World = {
  files: Map<string, string>; submitted: any[]; judged: string[]; judge: Judge; surfaces: string[]; registered: string[]
  // what the model received: user messages in the transcript (null: messages() unavailable)
  heard: string[] | null
  unreadable: Set<string>
  tools: any[]
}

// What the judge model would answer: every item it is shown, with the status `status(id)`.
const verdict = (status: (id: string) => string, promises: string[] = []) => (prompt: string) => {
  const ids = [...prompt.matchAll(/^(\d+) \[/gm)].map(m => m[1])
  return { isAnswered: true, text: JSON.stringify({ items: ids.map(id => ({ id, status: status(id), reason: 'r' })), promises }), usage: {} }
}

function world(on: any, env: Record<string, string> = {}): World {
  const w: World = { files: new Map(), submitted: [], judged: [], judge: verdict(() => 'open'), surfaces: ['terminal'], registered: [], heard: [], unreadable: new Set(), tools: [] }
  w.files.set(FILE, JSON.stringify(BASE))
  mock.env(on, { CLAUDE_FLEET_DIR: DIR, HOME: '/home/u', ...env })
  on('session.id', () => ({ value: ID }))
  on('session.turns', () => ({ value: 0 }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('session.messages', () => {
    if (w.heard === null) throw new Error('no transcript')
    return { value: w.heard.map(text => ({ role: 'user', text, toolUses: [] })) }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_$: any, e: any) => {
    if (w.unreadable.has(e.path)) throw new Error(`EACCES ${e.path}`)
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$: any, e: any) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_$: any, e: any) => {
    const pre = `${e.path}/`
    const names = [...w.files.keys()].filter(f => f.startsWith(pre) && !f.slice(pre.length).includes('/'))
    return { value: names.map(f => ({ name: f.slice(pre.length), kind: 'file', size: 1 })) }
  })
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    let exitCode = 0
    if (argv[0] === 'mv') {
      const [src, dst] = argv.slice(-2)
      if (w.files.has(src)) { w.files.set(dst, w.files.get(src) ?? ''); w.files.delete(src) } else exitCode = 1
    }
    if (argv[0] === 'rm') for (const f of argv.slice(2)) w.files.delete(f)
    const stdout = argv[0] === '/bin/sh' ? '4242\n' : argv[0] === 'tmux' ? 'w1\n' : ''
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async (_$: any, e: any) => { w.judged.push(e.prompt); return { value: await w.judge(e.prompt, e) } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => { w.submitted.push(e); return { text: e.text } })
  on('command.register', (_$: any, e: any) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('tool.register', (_$: any, e: any) => { w.tools.push(e); return { value: { tool: `mcp__ghostfleet__${e.name}` } } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The model's side of a step: what the step's response said, as the engine returns it.
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: e.model, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

const start = ($: any) => $.session.start({ cwd: '/w/acme-api', surface: null, isInteractive: true })
const book = (w: World) => JSON.parse(w.files.get(LEDGER) ?? 'null')
const rec = (w: World) => JSON.parse(w.files.get(FILE) ?? 'null')
// A message the person typed: idle (no turnId) or over a running turn.
const type = ($: any, text: string, turnId?: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) } as any)
const done = (turnId: string, answer: string, extra: object = {}) =>
  ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer', ...extra }) as any
// The judge runs after turn.complete resolved, unawaited: let it finish.
const settle = async (clock: any) => { for (let i = 0; i < 6; i++) await clock.advance(10) }
// One model step of a turn that wrote `text` ('' for a step that only called tools). The
// stub beneath answers with the text it is handed, carried in `model`.
const step = async ($: any, turnId: string, index: number, text: string, extra: object = {}) => {
  const s = $.turn.step({ turnId, index, model: text, messageCount: 1, ...extra } as any)
  for await (const _ of s) { /* drained */ }
  return s.result
}
// The re-prompts the gate sent: the mod's own framed submits, not the test's typing.
// ledger.js GATE_COOLDOWN_MS, and a little: two re-prompts are never closer than that.
const COOLDOWN = 5 * 60_000 + 1000
const nags = (w: World) => w.submitted.filter(e => e.origin?.kind === 'plugin' && !e.origin?.asUser)

test('a task and two messages typed mid-turn are three open items, on the record and the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  await type($, 'also bump the version', 't1')
  await type($, 'and add a changelog line', 't1')
  const l = book(w)
  expect(l.items.map((i: any) => [i.id, i.state, i.source, i.turnId ?? ''])).toEqual([
    ['1', 'open', 'user', 't1'], ['2', 'open', 'user', 't1'], ['3', 'open', 'user', 't1'],
  ])
  expect(rec(w).ledger).toEqual(expect.objectContaining({ open: 3, promises: 0 }))
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 } } } as any)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('')
  expect(text).toContain('ledger · 3 open · oldest')
  expect(text).toContain('fix the login redirect')
  await ui.unmount()
})

test('a ledger that cannot be read is left alone, never written over as empty', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  const kept = w.files.get(LEDGER)
  expect(kept).toContain('fix the login redirect')
  w.unreadable.add(LEDGER)
  await type($, 'also bump the version')
  expect(w.files.get(LEDGER)).toBe(kept)
})

test('slash commands are not requests', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await start($)
  await type($, '/fleet')
  expect(book(w)?.items ?? []).toEqual([])
})

test('the judge closes what the answer addressed; ONE re-prompt for the rest, and no second', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  await type($, 'also bump the version', 't1')
  await type($, 'and add a changelog line', 't1')
  w.heard = ['fix the login redirect', 'also bump the version', 'and add a changelog line']
  w.judge = verdict(id => (id === '3' ? 'open' : id === '2' ? 'not-done' : 'done'))
  await $.turn.complete(done('t1', 'Fixed the redirect. Did not bump the version: it is release-managed.'))
  await settle(clock)
  expect(w.judged.length).toBe(1)
  expect(book(w).items.map((i: any) => i.state)).toEqual(['done', 'not-done', 'open'])
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('3. "and add a changelog line"')
  expect(nags(w)[0].text).not.toContain('login redirect')
  // the re-prompt is not an item of its own
  expect(book(w).items.length).toBe(3)
  expect(book(w).items[2].gated).toBe(true)
  // its turn ignores the item again: judged, still open, never re-prompted
  await $.turn.start({ text: nags(w)[0].text, turnId: 't2' })
  w.judge = verdict(() => 'open')
  await $.turn.complete(done('t2', 'Looking at other things.'))
  await settle(clock)
  expect(w.judged.length).toBe(2)
  expect(nags(w).length).toBe(1)
  expect(book(w).items[2].state).toBe('open')
})

test('a queued message pulled back out of the queue (Up) is dropped, not nagged about', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'write a haiku about rain')
  await $.turn.start({ text: 'write a haiku about rain', turnId: 't1' })
  await type($, 'also list ten primes', 't1')
  w.heard = ['write a haiku about rain']          // the second never reached the model
  w.judge = verdict(id => (id === '1' ? 'done' : 'open'))
  await $.turn.complete(done('t1', 'Soft patter on leaves...'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(book(w).items.map((i: any) => i.text)).toEqual(['write a haiku about rain'])
  // and with no way to read what the model received, a queued item is not nagged about either
  await type($, 'and a limerick', 't1')
  w.heard = null
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(done('t2', 'Done.'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(book(w).items.length).toBe(2)
})

test('an Esc mid-turn: no judge call, no re-prompt', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  await $.turn.complete({ ...done('t1', ''), reason: 'aborted', isAborted: true })
  await settle(clock)
  expect(w.judged).toEqual([])
  expect(nags(w)).toEqual([])
  expect(book(w).items[0].state).toBe('open')
})

test('a subagent finishing, and a headless session, never judge', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  await $.turn.complete(done('t1', 'subagent report', { agentId: 'agent-7' }))
  await settle(clock)
  expect(w.judged).toEqual([])
  w.surfaces = []
  await $.turn.complete(done('t1', 'done'))
  await settle(clock)
  expect(w.judged).toEqual([])
  expect(nags(w)).toEqual([])
})

test('a judge that fails fails OPEN: nothing closes, nothing is re-prompted, the failure is kept', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  w.judge = () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} })
  await $.turn.complete(done('t1', 'Refactored.'))
  await settle(clock)
  expect(w.judged.length).toBe(1)
  expect(book(w).items[0].state).toBe('open')
  expect(book(w).judge).toEqual(expect.objectContaining({ ok: false }))
  expect(nags(w)).toEqual([])
  // a reply that is not the JSON asked for is a failure too
  w.judge = () => ({ isAnswered: true, text: 'Sure! Item 1 looks done.', usage: {} })
  await $.turn.complete(done('t1', 'Refactored.'))
  await settle(clock)
  expect(book(w).items[0].state).toBe('open')
  expect(nags(w)).toEqual([])
})

test('a message queued behind the turn starts the next one first: no re-prompt over it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  let answer: (v: any) => void = () => {}
  w.judge = () => new Promise(r => { answer = r })
  await $.turn.complete(done('t1', 'Halfway there.'))
  await clock.advance(10)
  await $.turn.start({ text: 'and the lexer', turnId: 't2' })
  answer(verdict(() => 'open')('1 [request'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(book(w).items[0].gated).toBeUndefined()
})

test('a queued turn that starts AND ends while the judge is out: no stale re-prompt, and its answer is judged next', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'list forty fruits')
  await $.turn.start({ text: 'list forty fruits', turnId: 't1' })
  await type($, 'and the capital of Australia', 't1')
  let answer: (v: any) => void = () => {}
  w.judge = () => new Promise(r => { answer = r })
  await $.turn.complete(done('t1', 'Apple, banana, cherry...'))
  await clock.advance(10)
  // the queued message runs as a turn of its own and is answered within the judge's call
  await $.turn.start({ text: 'and the capital of Australia', turnId: 't2' })
  await $.turn.complete(done('t2', 'Canberra.'))
  await clock.advance(10)
  w.judge = verdict(() => 'done')
  answer(verdict(id => (id === '1' ? 'done' : 'open'))('1 [x\n2 [x'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(w.judged.length).toBe(2)
  expect(w.judged[1]).toContain('Canberra.')
  expect(book(w).items.map((i: any) => i.state)).toEqual(['done', 'done'])
})

test('"I\'ll merge once CI is green" becomes a promise, shown and not gated by default', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  w.judge = verdict(() => 'open', ['merge the PR once CI is green'])
  await $.turn.complete(done('t1', "PR is open. I'll merge it once CI is green."))
  await settle(clock)
  expect(book(w).items.map((i: any) => [i.source, i.text, i.state])).toEqual([['promise', 'merge the PR once CI is green', 'open']])
  expect(rec(w).ledger).toEqual(expect.objectContaining({ open: 0, promises: 1 }))
  expect(nags(w)).toEqual([])
})

test('an answer with no promise wording and nothing open makes no judge call at all', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  await $.turn.complete(done('t1', 'The tests pass.'))
  await settle(clock)
  expect(w.judged).toEqual([])
})

test('CLAUDE_FLEET_LEDGER_PROMISES=gate: a promise a later turn of the same prompt leaves open is re-prompted once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { CLAUDE_FLEET_LEDGER_PROMISES: 'gate' })
  await start($)
  await type($, 'ship the release')
  await $.turn.start({ text: 'ship the release', turnId: 't1' })
  w.judge = verdict(id => (id === '1' ? 'done' : 'open'), ['merge the PR once CI is green'])
  await $.turn.complete(done('t1', "Release cut. I'll merge it once CI is green."))
  await settle(clock)
  // not in the turn that made it: the promise is for later
  expect(nags(w)).toEqual([])
  w.judge = verdict(() => 'open')
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(done('t2', 'Updated the docs.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('(you said you would) "merge the PR once CI is green"')
})

test('CLAUDE_FLEET_LEDGER_GATE=off records and judges, never re-prompts', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { CLAUDE_FLEET_LEDGER_GATE: 'off' })
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  await $.turn.complete(done('t1', 'Something else.'))
  await settle(clock)
  expect(w.judged.length).toBe(1)
  expect(nags(w)).toEqual([])
})

test('CLAUDE_FLEET_LEDGER=off: no file, no record field, no command, no model call', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { CLAUDE_FLEET_LEDGER: 'off' })
  await start($)
  await type($, 'refactor the parser')
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' })
  await $.turn.complete(done('t1', "I'll do it later."))
  await settle(clock)
  expect(w.files.has(LEDGER)).toBe(false)
  expect(rec(w).ledger).toBeUndefined()
  expect(w.registered).not.toContain('ledger')
  expect(w.judged).toEqual([])
})

test('a prompt fleet-send handed over is a fleet item', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(`${SPOOL}/1000-1.json`, JSON.stringify({ id: '1000-1', text: 'run the tests' }))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['run the tests'])
  await $.turn.start({ text: 'run the tests', turnId: 't7' })
  expect(book(w).items.map((i: any) => [i.source, i.text, i.turnId])).toEqual([['fleet', 'run the tests', 't7']])
})

test('/ledger lists, closes by hand, and clears, without a turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await type($, 'also bump the version')
  const list = await $.command.run({ command: 'ledger', args: '' } as any)
  expect(list.text).toContain('fix the login redirect')
  expect((await $.command.run({ command: 'ledger', args: 'close 1' } as any)).text).toBe('ledger: closed 1')
  expect((await $.command.run({ command: 'ledger', args: 'close 1' } as any)).text).toBe('ledger: no open item 1')
  expect(book(w).items[0]).toEqual(expect.objectContaining({ state: 'done', closedBy: 'person' }))
  await $.command.run({ command: 'ledger', args: 'clear' } as any)
  await clock.advance(10)
  expect(rec(w).ledger.open).toBe(0)
})

// THE WHOLE TURN, NOT ITS LAST BLOCK. Measured live: a turn wrote a post in its first block,
// ran two commands, and ended "The draft is above. The publish went through…; I'm checking
// the registry until it does". turn.complete's `answer` is that last block alone, so the
// judge was shown "the draft is above" with nothing above it, kept the request open, and the
// gate re-prompted for a reply the person had just read. The stub judge answers "done" only
// when it can SEE the draft: these rows go red if the judge is handed `e.answer` again.
const DRAFT = 'acme-api 0.5.0 is out: faster startup, a new sync command, fewer dependencies.'
const LAST = "The draft is above. The publish went through: the registry accepted 0.5.0 and said it may take a few minutes to show up. I'm checking the registry until it does…"
const seesDraft = (prompt: string) => verdict(() => (prompt.includes(DRAFT) ? 'done' : 'open'))(prompt)

test('a draft written early in the turn closes the request the turn ends by pointing at', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'done now draft the post')
  await $.turn.start({ text: 'done now draft the post', turnId: 't1' })
  w.judge = seesDraft
  await step($, 't1', 0, DRAFT)
  await step($, 't1', 1, '')
  await step($, 't1', 2, '')
  await step($, 't1', 3, LAST)
  await $.turn.complete(done('t1', LAST))
  await settle(clock)
  expect(w.judged.length).toBe(1)
  // in order, labelled, the last block named as the end
  const p = w.judged[0]
  expect(p.indexOf('[block 1 of 2]')).toBeGreaterThan(-1)
  expect(p.indexOf(DRAFT)).toBeLessThan(p.indexOf(LAST))
  expect(p).toContain('the LAST block (2 of 2)')
  expect(book(w).items[0].state).toBe('done')
  expect(nags(w).length).toBe(0)
})

test('a turn whose steps were missed (a reload mid-turn) is judged on its final text: the old input, and it nags', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'done now draft the post')
  await $.turn.start({ text: 'done now draft the post', turnId: 't1' })
  w.judge = seesDraft
  await $.turn.complete(done('t1', LAST))
  await settle(clock)
  expect(w.judged[0]).not.toContain(DRAFT)
  expect(w.judged[0]).not.toContain('[block')
  expect(book(w).items[0].state).toBe('open')
  expect(nags(w).length).toBe(1)
})

test("a subagent's steps are not the main turn's text, and a turn's text is not the next turn's", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'done now draft the post')
  await $.turn.start({ text: 'done now draft the post', turnId: 't1' })
  w.judge = seesDraft
  await step($, 't1', 0, DRAFT, { agentId: 'agent-7' })
  await step($, 't1', 1, LAST)
  await $.turn.complete(done('t1', LAST))
  await settle(clock)
  expect(w.judged[0]).not.toContain(DRAFT)
  expect(book(w).items[0].state).toBe('open')
  // the next turn starts with nothing of t1's carried as its own blocks
  await type($, 'and one more line', undefined)
  await $.turn.start({ text: 'and one more line', turnId: 't2' })
  await step($, 't2', 0, 'Added.')
  await $.turn.complete(done('t2', 'Added.'))
  await settle(clock)
  const p = w.judged[1]
  expect(p.slice(p.indexOf('THIS TURN'))).not.toContain(LAST)
})

// THE PERSON'S WORDS, NOT THE PASTE. Measured live, the same session: "u see what it just did"
// + a pasted transcript (the previous turn's draft AND the gate's re-prompt) + "its like
// reminding literally the last response". The item kept the paste's first lines; the person's
// words fell past the excerpt; the judge read a pasted reminder as the request and the gate
// re-prompted it. The ITEM is what the judge is shown, so that is what these rows hold.
const REMINDER = [
  'The ghostfleet plugin sent a message:',
  '[ghostfleet ledger] One request is still open from this session:',
  '12. "done now draft the post"',
  'Finish each one now, or say for each that it is not done and why. (Asked once per item; it will not be asked again.)',
  '',
  "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.",
].join('\n')
const PASTED = `u see what it just did <pasted_content id="ab12">⏺ ${DRAFT}\n⏺ ${LAST}\n${REMINDER}</pasted_content id="ab12"> its like reminding literally the last response`
const itemsOf = (prompt: string) => prompt.slice(prompt.indexOf('ITEMS:'), prompt.indexOf('THIS TURN'))

test('a message that is mostly a paste is the person\'s own words, the paste set aside and marked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, PASTED)
  await $.turn.start({ text: PASTED, turnId: 't1' })
  expect(book(w).items[0].text).toBe('u see what it just did its like reminding literally the last response [+ pasted text]')
  expect(book(w).items[0].turnId).toBe('t1')
  await step($, 't1', 0, 'Yes: the gate re-prompted a request the turn had answered. Sent a fix to a worker.')
  await $.turn.complete(done('t1', 'Yes: the gate re-prompted a request the turn had answered. Sent a fix to a worker.'))
  await settle(clock)
  const items = itemsOf(w.judged[0])
  expect(items).toContain('reminding literally the last response')
  expect(items).not.toContain(DRAFT)
  expect(items).not.toContain('[ghostfleet ledger]')
})

test('a ledger reminder quoted back is never a request: alone it is no item, inside a message it is dropped', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, REMINDER)
  await type($, `<pasted_content id="cd34">${REMINDER}</pasted_content id="cd34">`)
  expect(book(w)?.items ?? []).toEqual([])
  await type($, `${REMINDER}\nwhy did it ask this`)
  expect(book(w).items.map((i: any) => i.text)).toEqual(['why did it ask this'])
})

test('a pasted message queued mid-turn and delivered is found in the transcript: nagged, not dropped as withdrawn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  await type($, PASTED, 't1')
  w.heard = ['fix the login redirect', PASTED]
  w.judge = verdict(id => (id === '1' ? 'done' : 'open'))
  await $.turn.complete(done('t1', 'Fixed the redirect.'))
  await settle(clock)
  expect(book(w).items.length).toBe(2)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('reminding literally the last response')
  expect(nags(w)[0].text).not.toContain('One request is still open from this session:\n12.')
})

// ONE MESSAGE, TWO ITEMS. Measured live: a message sent, stopped with Esc before the turn
// wrote anything (which rewinds it out of the conversation and hands it back to the
// composer), then sent again with a few words added. Two prompt.submits, two items with the
// same excerpt, and the gate named both. The transcript holds the resend alone.
const RESENT = `<pasted_content id="ef56">acme-api 0.5.0 draft: faster startup, a sync command.</pasted_content id="ef56"> dont lead with the version, its more of a harness?? what do u think`

test('a message stopped before it was answered and sent again is ONE request: the rewound copy is dropped, not nagged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, RESENT)
  await $.turn.start({ text: RESENT, turnId: 't1' })
  await $.turn.complete({ ...done('t1', ''), reason: 'aborted', isAborted: true })
  await settle(clock)
  expect(book(w).items[0].interrupted).toBe(true)
  // sent again as it came back (the live resend added a few words past the excerpt's head)
  await type($, RESENT)
  await $.turn.start({ text: RESENT, turnId: 't2' })
  w.heard = [RESENT]
  w.judge = verdict(() => 'open')
  await step($, 't2', 0, 'It reads more like an orchestration layer than a harness.')
  await $.turn.complete(done('t2', 'It reads more like an orchestration layer than a harness.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('One request is')
  expect(book(w).items.map((i: any) => i.id)).toEqual(['2'])
  expect(book(w).items[0].text).toContain('what do u think')
})

test('the same words sent twice and both answered are two requests; a stopped message that reached the model stays (and, older, is not re-prompted)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'run the tests')
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  // stopped AFTER it started answering: the message stays in the conversation
  await $.turn.complete({ ...done('t1', 'Running…'), reason: 'aborted', isAborted: true })
  await type($, 'run the tests')
  await $.turn.start({ text: 'run the tests', turnId: 't2' })
  w.heard = ['run the tests', 'run the tests']
  w.judge = verdict(() => 'open')
  await $.turn.complete(done('t2', 'Looking at something else.'))
  await settle(clock)
  expect(book(w).items.map((i: any) => [i.id, i.state])).toEqual([['1', 'open'], ['2', 'open']])
  expect(nags(w).length).toBe(1)
  // the gate names the latest prompt's item only; the first send stays open, on the band
  expect(nags(w)[0].text).toContain('One request is')
  expect(nags(w)[0].text).toContain('2. "run the tests"')
  expect(nags(w)[0].text).not.toContain('1. "run the tests"')
})

test('a long message with an inline paste keeps the words typed after it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  const inline = `${DRAFT} ${DRAFT} ${DRAFT} ${DRAFT} dont lead with the version, its more of a harness?? what do u think`
  await type($, inline)
  const t = book(w).items[0].text
  expect(t.length).toBeLessThanOrEqual(240)
  expect(t.startsWith(DRAFT.slice(0, 60))).toBe(true)
  expect(t.endsWith('what do u think')).toBe(true)
  await $.turn.start({ text: inline, turnId: 't1' })
  expect(book(w).items[0].turnId).toBe('t1')
})

// THE JUDGE NEVER RUNS OUT OF REPLY. Measured live: a session's ledger reached 46 open items,
// the one judge call asked for 46 verdicts within 700 tokens of reply, the reply was cut off
// before its closing brace, and the whole of it was dropped. Nothing closed, so the next turn
// asked about more items and failed the same way, and the band only showed a growing count.
// This judge answers like the model does: one object per item with a reason of a dozen
// words, cut at the call's own token budget at 2 characters a token, as measured on haiku's
// verdicts (934 characters took 589 tokens; 3,705 took 1,737).
const budgeted = (status: (id: string) => string) => (prompt: string, call: any) => {
  const ids = [...prompt.matchAll(/^(\d+) \[/gm)].map(m => m[1])
  const reason = 'the agent reported this finished in its final block of the turn'
  const full = JSON.stringify({ items: ids.map(id => ({ id, status: status(id), reason })), promises: [] })
  return { isAnswered: true, text: full.slice(0, (call?.maxTokens ?? 700) * 2), usage: {} }
}
const band = async ($: any, cols = 160) => {
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: cols, scroll: { offset: 0, bodyRows: 5 } } } as any)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('')
  await ui.unmount()
  return text
}

test('46 open items: every verdict lands, none lost to a cut-off reply', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  for (let k = 1; k <= 46; k++) await type($, `request number ${k} for acme-api`)
  await $.turn.start({ text: '', turnId: 't1' })
  w.heard = null
  w.judge = budgeted(() => 'done')
  await $.turn.complete(done('t1', 'All of them are done.'))
  await settle(clock)
  expect(book(w).items.filter((i: any) => i.state === 'open').map((i: any) => i.id)).toEqual([])
  expect(book(w).judge).toEqual(expect.objectContaining({ ok: true, items: 46 }))
  // no call asked about more items than its reply can hold, and the newest were asked first
  for (const p of w.judged) expect([...p.matchAll(/^(\d+) \[/gm)].length).toBeLessThanOrEqual(10)
  expect(w.judged[0]).toContain('46 [request')
  expect(nags(w)).toEqual([])
})

test('a reply cut off mid-item still applies the items it finished; the rest stay open', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await type($, 'also bump the version')
  await type($, 'and add a changelog line')
  await $.turn.start({ text: '', turnId: 't1' })
  w.heard = null
  const full = JSON.stringify({ items: ['3', '2', '1'].map(id => ({ id, status: 'done', reason: 'reported finished' })), promises: [] })
  const cut = full.slice(0, full.indexOf('"id":"1"') + 12)
  w.judge = () => ({ isAnswered: true, text: cut, usage: {} })
  await $.turn.complete(done('t1', 'Done with the version and the changelog.'))
  await settle(clock)
  expect(book(w).items.map((i: any) => i.state)).toEqual(['open', 'done', 'done'])
  expect(book(w).judge).toEqual(expect.objectContaining({ ok: false, why: 'reply cut off after 2 of 3 items' }))
  // a cut-off reply is a failing judge: it is shown, and nothing is re-prompted on it
  expect(nags(w)).toEqual([])
})

test('a failing judge is on the band and in /ledger; a working one clears it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'refactor the parser')
  await type($, 'and the lexer')
  await $.turn.start({ text: '', turnId: 't1' })
  w.heard = null
  w.judge = () => ({ isAnswered: true, text: 'Sure! Item 1 looks done.', usage: {} })
  await $.turn.complete(done('t1', 'Refactored.'))
  await settle(clock)
  expect(await band($)).toContain('ledger · judge failing: reply was not the JSON asked for · 2 open')
  expect(await band($, 30)).toContain('judge failing')
  expect((await $.command.run({ command: 'ledger', args: '' } as any)).text)
    .toContain('last judge: FAILING, failed open: reply was not the JSON asked for')
  expect(rec(w).ledger.judge_failing).toBe('reply was not the JSON asked for')
  // the next judge call works: the band drops the failure, the listing says ok
  w.judge = verdict(id => (id === '1' ? 'done' : 'open'))
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(done('t2', 'Refactored the parser.'))
  await settle(clock)
  const after = await band($)
  expect(after).toContain('ledger · 1 open')
  expect(after).not.toContain('judge failing')
  expect((await $.command.run({ command: 'ledger', args: '' } as any)).text).toContain('last judge: ok, 2 items in 1 call')
  expect(rec(w).ledger.judge_failing).toBeUndefined()
})

test('a promise no judged turn addresses closes as stale after five; one addressed in time closes as done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await $.turn.start({ text: '', turnId: 't0' })
  w.judge = verdict(() => 'open', ['merge the PR once CI is green'])
  await $.turn.complete(done('t0', "I'll merge it once CI is green."))
  await settle(clock)
  w.judge = verdict(() => 'open')
  for (let k = 1; k <= 4; k++) {
    await $.turn.start({ text: '', turnId: `t${k}` })
    await $.turn.complete(done(`t${k}`, 'Updated the docs.'))
    await settle(clock)
  }
  expect(book(w).items[0]).toEqual(expect.objectContaining({ state: 'open', keptOpen: 4 }))
  expect(await band($)).toContain('promise: merge the PR once CI is green')
  await $.turn.start({ text: '', turnId: 't5' })
  await $.turn.complete(done('t5', 'Updated the docs.'))
  await settle(clock)
  expect(book(w).items[0]).toEqual(expect.objectContaining({ state: 'stale', closedBy: 'judge' }))
  expect(rec(w).ledger).toEqual(expect.objectContaining({ open: 0, promises: 0 }))
  expect(nags(w)).toEqual([])
  // a request kept open as long is NOT closed: only promises go stale
  await type($, 'fix the login redirect')
  for (let k = 6; k <= 12; k++) {
    await $.turn.start({ text: '', turnId: `t${k}` })
    await $.turn.complete(done(`t${k}`, 'Looking at other things.'))
    await settle(clock)
  }
  expect(book(w).items[1].state).toBe('open')
  // and a promise judged done on its third turn closes as done, never stale
  w.judge = verdict(() => 'open', ['tag the release after the merge'])
  await $.turn.start({ text: '', turnId: 't13' })
  await $.turn.complete(done('t13', "I'll tag the release after the merge."))
  await settle(clock)
  const p = book(w).items.find((i: any) => i.text === 'tag the release after the merge')
  w.judge = verdict(id => (id === p.id ? 'done' : 'open'))
  await $.turn.start({ text: '', turnId: 't14' })
  await $.turn.complete(done('t14', 'Tagged it.'))
  await settle(clock)
  expect(book(w).items.find((i: any) => i.id === p.id).state).toBe('done')
})

// ONE COMMITMENT, ONE PROMISE. Measured live: four open promises were one follow-up in four
// phrasings, added on three consecutive turns, because the judge was never shown which
// promises were open and the only dedupe was exact text. And two "promises" were steps the
// agent asked the PERSON to take, read off a closing "Still waiting on you:" list.
const promised = (list: any[], status: (id: string) => string = () => 'open') => (prompt: string) =>
  ({ ...verdict(status)(prompt), text: JSON.stringify({ items: [...prompt.matchAll(/^(\d+) \[/gm)].map(m => ({ id: m[1], status: status(m[1]), reason: 'r' })), promises: list }) })
const openPromises = (w: World) => book(w).items.filter((i: any) => i.source === 'promise' && i.state === 'open')
const turn = async ($: any, clock: any, id: string, answer: string) => {
  await $.turn.start({ text: '', turnId: id })
  await $.turn.complete(done(id, answer))
  await settle(clock)
}

test('a promise the judge says restates an open one is that one, in its newer words; the judge is shown the open ones', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.judge = promised(['merge the PR once CI is green'])
  await turn($, clock, 't1', "I'll merge the PR once CI is green.")
  w.judge = promised([{ text: 'land the change when the checks pass', by: 'agent', same: '1' }])
  await turn($, clock, 't2', "I'll land it when the checks pass.")
  expect(w.judged[1]).toContain('ALREADY OPEN PROMISES')
  expect(w.judged[1]).toContain('1: merge the PR once CI is green')
  expect(openPromises(w).map((i: any) => [i.id, i.text])).toEqual([['1', 'land the change when the checks pass']])
})

test('the same follow-up in four phrasings over three turns is one promise; three different ones stay three', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.judge = promised(['read the ledgers after the next turns'])
  await turn($, clock, 't1', "I'll read the ledgers after the next turns.")
  w.judge = promised(['watch for re-prompt closure in acme-api and acme-web'])
  await turn($, clock, 't2', "I'll watch for re-prompt closure in acme-api and acme-web.")
  w.judge = promised(['check acme-api, acme-web, toolbox ledgers after next turns', 'read acme-api, acme-web, toolbox ledgers after next turns'])
  await turn($, clock, 't3', "I'll check the acme-api, acme-web, toolbox ledgers after the next turns.")
  expect(openPromises(w).map((i: any) => i.text)).toEqual(['read the ledgers after the next turns'])
  expect(book(w).items.find((i: any) => i.id === '2')).toEqual(expect.objectContaining({ state: 'stale', reason: 'same as promise 1' }))
  w.judge = promised(['merge the PR once CI is green', 'tag the release after the merge', 'add the changelog entry for acme-web 0.6'])
  await turn($, clock, 't4', "I'll merge once CI is green, then tag the release, and add the changelog entry.")
  expect(openPromises(w).length).toBe(4)
})

test("what the agent asks the PERSON to do is not its promise", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.judge = promised([
    { text: 'Run npm login && npm publish', by: 'person', same: '' },
    { text: 'Type /reload-plugins between turns', by: 'person', same: '' },
    'wait for you to approve the release',
    { text: 'rerun the acme-api smoke test', by: 'agent', same: '' },
  ])
  await turn($, clock, 't1', "I'll rerun the acme-api smoke test.\n\nStill waiting on you:\n- Run npm login && npm publish\n- Type /reload-plugins between turns")
  expect(w.judged[0]).toContain('waiting on you')
  expect(w.judged[0]).toContain('"by":"agent|person"')
  expect(openPromises(w).map((i: any) => i.text)).toEqual(['rerun the acme-api smoke test'])
})

test('at most five open promises: a sixth stales the oldest', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  const seven = ['merge the PR', 'tag the release', 'publish to npm', 'update the docs site', 'rotate the deploy key', 'bump acme-web', 'archive toolbox']
  for (const [k, p] of seven.entries()) {
    // judges no item, so the five-turn stale rule never fires: only the cap closes one here
    w.judge = () => ({ isAnswered: true, text: JSON.stringify({ items: [], promises: [p] }), usage: {} })
    await turn($, clock, `t${k}`, `I'll ${p} next.`)
  }
  expect(openPromises(w).map((i: any) => i.text)).toEqual(seven.slice(2))
  expect(book(w).items[0]).toEqual(expect.objectContaining({ state: 'stale', reason: 'over the cap of 5 open promises' }))
})

// ── THE HYBRID: the agent closes its own items with proof; the judge is the backup ─────────
const CLOSE = 'mcp__ghostfleet__ledger_close'
const DROP = 'mcp__ghostfleet__ledger_drop'
const ADD = 'mcp__ghostfleet__ledger_add'
const tool = async ($: any, name: string, args: object) => String(((await $.tool.call({ tool: name, ...args } as any)) as any).result)
const THREE = 'Shorten the intro to three lines. Can you add the pricing table under it? And send me the preview link when it is done.'
// The note each prompt carried to the model, as the engine beneath received it.
const notes = (w: World) => w.submitted.map(e => (e.context ?? []).join('\n'))

test('decision 1: the three tools are registered, and ledger_close needs proof and records who closed it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  expect(w.tools.map(t => t.name)).toEqual(['ledger_close', 'ledger_drop', 'ledger_add'])
  expect(w.tools[0].inputSchema.required).toEqual(['id', 'proof'])
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  expect(await tool($, CLOSE, { id: '1', proof: '  ' })).toContain('proof is required')
  expect(book(w).items[0].state).toBe('open')
  expect(await tool($, CLOSE, { id: '9', proof: 'x' })).toBe('ledger: no item 9')
  expect(await tool($, CLOSE, { id: '1', proof: 'commit 1a2b3c on fix/login, test/run.sh green' })).toBe('ledger: 1 closed')
  expect(book(w).items[0]).toEqual(expect.objectContaining({
    state: 'done', closedBy: 'agent', proof: 'commit 1a2b3c on fix/login, test/run.sh green', closedTurn: 't1',
  }))
  expect(await tool($, CLOSE, { id: '1', proof: 'again' })).toBe('ledger: item 1 is already done')
  await clock.advance(10)
  expect(rec(w).ledger.open).toBe(0)
})

test('decision 1: ledger_drop needs a reason; ledger_add tracks a missed ask in the latest prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  expect(await tool($, DROP, { id: '1', reason: '' })).toContain('a reason is required')
  expect(await tool($, ADD, { text: 'and add a regression test' })).toBe('ledger: tracking 2')
  expect(await tool($, DROP, { id: '1', reason: 'the person withdrew it' })).toBe('ledger: 1 dropped')
  const [a, b] = book(w).items
  expect(a).toEqual(expect.objectContaining({ state: 'dropped', closedBy: 'agent', reason: 'the person withdrew it' }))
  expect(b).toEqual(expect.objectContaining({ state: 'open', source: 'user', addedBy: 'agent', prompt: a.prompt, turnId: 't1' }))
  // the added ask is the latest prompt's: the gate covers it
  w.judge = verdict(() => 'open')
  await $.turn.complete(done('t1', 'Fixed the redirect.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('2. "and add a regression test"')
})

test('decision 2: the prompt carries a note of the open items by id, requests first, capped; none when nothing is open', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  // a notification with nothing open: no note at all
  await $.prompt.submit({ text: 'background task finished', origin: { kind: 'task-notification' }, wait: false } as any)
  expect(notes(w)).toEqual([''])
  await type($, THREE)
  const note = notes(w)[1]
  expect(note.split('\n')[0]).toBe('[ghostfleet ledger: open items]')
  // its own three asks, newest first, by id
  expect(note).toContain('3 (asked): And send me the preview link when it is done.\n2 (asked): Can you add the pricing table under it?\n1 (asked): Shorten the intro to three lines.')
  expect(note).toContain(`call ${CLOSE} with its id and the proof`)
  // a promise sorts after every request, and past eight items the rest is a count
  const l = book(w)
  l.items.push({ id: '4', text: 'merge once CI is green', at: 1_000_000, state: 'open', source: 'promise' })
  l.seq = 4
  w.files.set(LEDGER, JSON.stringify(l))
  for (const t of ['fix a', 'fix b', 'fix c', 'fix d', 'fix e', 'fix f']) await type($, t)
  const last = notes(w)[notes(w).length - 1]
  const rows = last.split('\n').filter(r => /^\d+ \(/.test(r))
  expect(rows.length).toBe(8)
  expect(rows.every(r => r.includes('(asked)'))).toBe(true)
  expect(last).toContain('+2 more open (/ledger lists them)')
  // closed, the next notification carries nothing
  await $.command.run({ command: 'ledger', args: 'clear' } as any)
  await $.prompt.submit({ text: 'background task finished', origin: { kind: 'task-notification' }, wait: false } as any)
  expect(notes(w)[notes(w).length - 1]).toBe('')
  await clock.advance(10)
})

test('decision 3: the gate names only the latest prompt; an item from two prompts ago stays open and is never re-prompted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.heard = ['rename the config key', 'bump the version', 'write the changelog line']
  // prompt 1, stopped before its end: never gated
  await type($, 'rename the config key')
  await $.turn.start({ text: 'rename the config key', turnId: 't1' })
  await $.turn.complete({ ...done('t1', 'Renaming…'), reason: 'aborted', isAborted: true })
  await settle(clock)
  // prompt 2 and prompt 3, each answered with nothing done, past the gate's cooldown apart
  w.judge = verdict(() => 'open')
  for (const [k, t] of [[2, 'bump the version'], [3, 'write the changelog line']] as const) {
    await clock.advance(COOLDOWN)
    await type($, t)
    await $.turn.start({ text: t, turnId: `t${k}` })
    await $.turn.complete(done(`t${k}`, 'Looked around.'))
    await settle(clock)
  }
  expect(nags(w).map(n => n.text.split('\n')[1])).toEqual(['2. "bump the version"', '3. "write the changelog line"'])
  expect(book(w).items.map((i: any) => [i.id, i.state, Boolean(i.gated)])).toEqual([['1', 'open', false], ['2', 'open', true], ['3', 'open', true]])
  // and it is still on the band and in /ledger
  expect((await $.command.run({ command: 'ledger', args: '' } as any)).text).toContain('rename the config key')
})

test('decision 3: a message queued over a turn joins that prompt, and a fleet-delivered prompt is a prompt of its own', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.heard = ['fix the login redirect', 'also bump the version']
  w.judge = verdict(() => 'open')
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  await type($, 'also bump the version', 't1')
  await $.turn.complete(done('t1', 'Fixed it.'))
  await $.turn.start({ text: 'also bump the version', turnId: 't2' })
  await $.turn.complete(done('t2', 'Looked.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('2 requests are')
  // a fleet delivery: the gate names it, and not the two already gated
  await clock.advance(COOLDOWN)
  w.files.set(`${SPOOL}/1000-1.json`, JSON.stringify({ id: '1000-1', text: 'run the tests' }))
  await clock.advance(500)
  await $.turn.start({ text: 'run the tests', turnId: 't3' })
  await $.turn.complete(done('t3', 'Looked.'))
  await settle(clock)
  expect(nags(w).length).toBe(2)
  expect(nags(w)[1].text).toContain('One request is')
  expect(nags(w)[1].text).toContain('3. "run the tests"')
})

test('decision 4: a 3-ask prompt the agent closes with proof costs no judge call, promise wording or not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, THREE)
  expect(book(w).items.map((i: any) => i.text)).toEqual([
    'Shorten the intro to three lines.', 'Can you add the pricing table under it?', 'And send me the preview link when it is done.',
  ])
  await $.turn.start({ text: THREE, turnId: 't1' })
  for (const [id, proof] of [['1', 'web/index.html:12, intro is 3 lines'], ['2', 'web/index.html:40, pricing table added'], ['3', 'http://localhost:4173/preview sent in the reply']])
    expect(await tool($, CLOSE, { id, proof })).toBe(`ledger: ${id} closed`)
  await $.turn.complete(done('t1', "All three done. I'll keep the preview server running."))
  await settle(clock)
  expect(w.judged).toEqual([])
  expect(nags(w)).toEqual([])
  expect(book(w).items.every((i: any) => i.state === 'done' && i.closedBy === 'agent')).toBe(true)
})

test('decision 4: what the agent skipped is judged alone, and gets one re-prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.heard = [THREE]
  await type($, THREE)
  await $.turn.start({ text: THREE, turnId: 't1' })
  await tool($, CLOSE, { id: '1', proof: 'web/index.html:12' })
  await tool($, CLOSE, { id: '2', proof: 'web/index.html:40' })
  w.judge = verdict(() => 'open')
  await $.turn.complete(done('t1', 'Shortened the intro and added the table.'))
  await settle(clock)
  expect(w.judged.length).toBe(1)
  expect([...w.judged[0].matchAll(/^(\d+) \[/gm)].map(m => m[1])).toEqual(['3'])
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('3. "And send me the preview link when it is done."')
  expect(nags(w)[0].text).not.toContain('Shorten')
  // the re-prompt's own turn: still open, never a second nag
  await $.turn.start({ text: nags(w)[0].text, turnId: 't2' })
  await $.turn.complete(done('t2', 'Still on it.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
})

test('decision 5: a ledger written before the hybrid is closable by the tools, and its items are never re-prompted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  // the shape a session already has on disk: no prompt numbers, no window, closedBy hand
  w.files.set(LEDGER, JSON.stringify({ v: 1, seq: 3, items: [
    { id: '1', text: 'update the README', at: 999_000, state: 'open', source: 'user', turnId: 'old1' },
    { id: '2', text: 'rotate the token', at: 999_000, state: 'open', source: 'user', turnId: 'old2' },
    { id: '3', text: 'tag the release', at: 999_000, state: 'done', source: 'user', closedBy: 'hand', closedAt: 999_500 },
  ] }))
  await start($)
  await type($, 'look at the logs')
  expect(notes(w)[0]).toContain('1 (asked): update the README')
  await $.turn.start({ text: 'look at the logs', turnId: 't1' })
  expect(await tool($, CLOSE, { id: '1', proof: 'README.md updated in commit 9f8e7d' })).toBe('ledger: 1 closed')
  w.judge = verdict(() => 'open')
  await $.turn.complete(done('t1', 'Read them.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('4. "look at the logs"')
  expect(nags(w)[0].text).not.toContain('rotate the token')
  const all = (await $.command.run({ command: 'ledger', args: 'all' } as any)).text
  expect(all).toContain('(agent: README.md updated in commit 9f8e7d)')
  expect(all).toContain('(person)')
})

test('the fleet\'s own nudge is a wake-up, never an item: matched by its handoff marker, not its words', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  // the words of a request, the marker of a nudge: no item
  w.files.set(`${SPOOL}/1000-1.json`, JSON.stringify({ id: '1000-1', text: 'run fleet-inbox and merge what is green', kind: 'nudge' }))
  await clock.advance(500)
  await $.turn.start({ text: 'run fleet-inbox and merge what is green', turnId: 't1' })
  expect(book(w)?.items ?? []).toEqual([])
  await $.turn.complete(done('t1', 'Merged.'))
  await settle(clock)
  expect(w.judged).toEqual([])
  // the same words with no marker are a request
  w.files.set(`${SPOOL}/1000-2.json`, JSON.stringify({ id: '1000-2', text: 'run fleet-inbox and merge what is green' }))
  await clock.advance(500)
  await $.turn.start({ text: 'run fleet-inbox and merge what is green', turnId: 't2' })
  expect(book(w).items.map((i: any) => [i.id, i.source, i.turnId])).toEqual([['1', 'fleet', 't2']])
  // a plugin's submit carries no context, so the turn's first tool result carries the note
  expect(notes(w)[1]).toBe('')
  const first: any = await $.tool.call({ tool: ADD, text: 'and post the result' } as any)
  expect((first.context ?? []).join('\n')).toContain('1 (asked): run fleet-inbox and merge what is green')
  const second: any = await $.tool.call({ tool: ADD, text: 'and one more' } as any)
  expect(second.context ?? []).toEqual([])
})

// ── the gate's guardrails: a turn that reported on its work is not re-prompted ──
// "open" used to mean both "the turn ignored it" and "the turn reported on it while the work
// went on elsewhere", and the gate re-prompted both: the agent could only repeat its report.

const verdictOf = (status: (id: string) => string, extra: object = {}) => (prompt: string) => {
  const ids = [...prompt.matchAll(/^(\d+) \[/gm)].map(m => m[1])
  return { isAnswered: true, text: JSON.stringify({ items: ids.map(id => ({ id, status: status(id), reason: 'r' })), promises: [], ...extra }), usage: {} }
}
const REPORT = 'Dry run done. The build is still in progress in a worker; I will ship it when it lands.'

test('an item the turn reported in progress is never re-prompted, and stays open, listed and judged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'build the acme-api export')
  await $.turn.start({ text: 'build the acme-api export', turnId: 't1' })
  w.heard = ['build the acme-api export']
  w.judge = verdictOf(() => 'in-progress')
  await $.turn.complete(done('t1', REPORT))
  await settle(clock)
  expect(nags(w)).toEqual([])
  const it = book(w).items[0]
  expect([it.state, Boolean(it.gated), it.progress?.turnId]).toEqual(['open', false, 't1'])
  expect(rec(w).ledger).toEqual(expect.objectContaining({ open: 1 }))
  expect((await $.command.run({ command: 'ledger', args: '' } as any)).text).toContain('[in progress')
  // a later turn still judges it, and still does not re-prompt it, even when it says nothing of it
  w.judge = verdictOf(() => 'open')
  await clock.advance(COOLDOWN)
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(done('t2', 'Checked the logs.'))
  await settle(clock)
  expect(w.judged.length).toBe(2)
  expect(w.judged[1]).toContain('1 [request')
  expect(nags(w)).toEqual([])
})

test('two asks, one in progress and one never mentioned: the re-prompt names only the ignored one, once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'build the acme-api export', )
  await $.turn.start({ text: 'build the acme-api export', turnId: 't1' })
  await type($, 'and rename the toolbox flag', 't1')
  w.heard = ['build the acme-api export', 'and rename the toolbox flag']
  w.judge = verdictOf(id => (id === '1' ? 'in-progress' : 'open'))
  await $.turn.complete(done('t1', REPORT))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(nags(w)[0].text).toContain('2. "and rename the toolbox flag"')
  expect(nags(w)[0].text).not.toContain('acme-api export')
  expect(book(w).items.map((i: any) => [i.id, i.state, Boolean(i.gated)])).toEqual([['1', 'open', false], ['2', 'open', true]])
})

test('a turn that ends on a question to the person is not re-prompted; the next one that ignores the item is', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'set up the billing-svc alerts')
  await $.turn.start({ text: 'set up the billing-svc alerts', turnId: 't1' })
  w.heard = ['set up the billing-svc alerts']
  w.judge = verdictOf(() => 'open', { waitingOnPerson: true })
  await $.turn.complete(done('t1', 'Which channel should they go to: a, b or c?'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(book(w).judge).toEqual(expect.objectContaining({ ok: true, held: 'waiting', heldItems: ['1'] }))
  expect(book(w).items[0].gated).toBeUndefined()
  w.judge = verdictOf(() => 'open')
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(done('t2', 'Looked at other things.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
})

test('the turn the re-prompt started is never re-prompted, even past the cooldown', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'fix the login redirect')
  await $.turn.start({ text: 'fix the login redirect', turnId: 't1' })
  w.heard = ['fix the login redirect']
  await $.turn.complete(done('t1', 'Looked around.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  // the re-prompt's own turn adds an ask the split missed (same window), runs long, ignores it
  await $.turn.start({ text: nags(w)[0].text, turnId: 't2' })
  expect(await tool($, ADD, { text: 'and add a test for it' })).toBe('ledger: tracking 2')
  await clock.advance(COOLDOWN)
  await $.turn.complete(done('t2', 'Fixed the redirect.'))
  await settle(clock)
  expect(nags(w).length).toBe(1)
  expect(book(w).judge.held).toBe('gate-turn')
})

test('at most one re-prompt per cooldown: an ask ignored right after one waits, one ignored later is named', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.heard = ['fix the login redirect', 'bump the version', 'write the changelog line']
  for (const [k, t] of [[1, 'fix the login redirect'], [2, 'bump the version']] as const) {
    await type($, t)
    await $.turn.start({ text: t, turnId: `t${k}` })
    await $.turn.complete(done(`t${k}`, 'Looked around.'))
    await settle(clock)
    await clock.advance(60_000)
  }
  expect(nags(w).length).toBe(1)
  expect(book(w).judge.held).toBe('cooldown')
  await clock.advance(COOLDOWN)
  await type($, 'write the changelog line')
  await $.turn.start({ text: 'write the changelog line', turnId: 't3' })
  await $.turn.complete(done('t3', 'Looked around.'))
  await settle(clock)
  expect(nags(w).length).toBe(2)
  expect(nags(w)[1].text).toContain('3. "write the changelog line"')
})

test("a lead whose workers are still working is not re-prompted", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(FILE, JSON.stringify({ ...BASE, slot: 'master' }))
  w.files.set(`${DIR}/kid.json`, JSON.stringify({ session_id: 'kid', sock: 'cf-acme-api', slot: 'w1', status: 'idle', ts: 1, source: 'mod', state: 'working', mod: { pid: 7, hb: 1_000_000 } }))
  await start($)
  await clock.advance(10)
  await type($, 'ship the acme-web redesign')
  await $.turn.start({ text: 'ship the acme-web redesign', turnId: 't1' })
  w.heard = ['ship the acme-web redesign']
  await $.turn.complete(done('t1', 'Dispatched w1.'))
  await settle(clock)
  expect(nags(w)).toEqual([])
  expect(book(w).judge.held).toBe('workers')
})

test('waiting on the person, and the follow-through of an in-progress item, are never promises', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await type($, 'build the acme-api export')
  await $.turn.start({ text: 'build the acme-api export', turnId: 't1' })
  w.heard = ['build the acme-api export']
  w.judge = verdictOf(() => 'in-progress', { promises: [
    { text: "wait for the user's reply", by: 'agent', same: '' },
    { text: 'ship the export once the worker lands', by: 'agent', same: '1' },
    { text: 'build the acme-api export after the dry run', by: 'agent', same: '' },
    { text: 'merge the PR once CI is green', by: 'agent', same: '' },
  ] })
  await $.turn.complete(done('t1', `${REPORT} I'll wait for your reply on the rest.`))
  await settle(clock)
  expect(book(w).items.filter((i: any) => i.source === 'promise').map((i: any) => i.text)).toEqual(['merge the PR once CI is green'])
})
