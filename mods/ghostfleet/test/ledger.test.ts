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

type Judge = (prompt: string) => any
type World = {
  files: Map<string, string>; submitted: any[]; judged: string[]; judge: Judge; surfaces: string[]; registered: string[]
  // what the model received: user messages in the transcript (null: messages() unavailable)
  heard: string[] | null
  unreadable: Set<string>
}

// What the judge model would answer: every item it is shown, with the status `status(id)`.
const verdict = (status: (id: string) => string, promises: string[] = []) => (prompt: string) => {
  const ids = [...prompt.matchAll(/^(\d+) \[/gm)].map(m => m[1])
  return { isAnswered: true, text: JSON.stringify({ items: ids.map(id => ({ id, status: status(id), reason: 'r' })), promises }), usage: {} }
}

function world(on: any, env: Record<string, string> = {}): World {
  const w: World = { files: new Map(), submitted: [], judged: [], judge: verdict(() => 'open'), surfaces: ['terminal'], registered: [], heard: [], unreadable: new Set() }
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
  on('model.complete', async (_$: any, e: any) => { w.judged.push(e.prompt); return { value: await w.judge(e.prompt) } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => { w.submitted.push(e); return { text: e.text } })
  on('command.register', (_$: any, e: any) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
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
// The re-prompts the gate sent: the mod's own framed submits, not the test's typing.
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

test('CLAUDE_FLEET_LEDGER_PROMISES=gate: a promise a later turn leaves open is re-prompted once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { CLAUDE_FLEET_LEDGER_PROMISES: 'gate' })
  await start($)
  await $.turn.start({ text: '', turnId: 't1' })
  w.judge = verdict(() => 'open', ['merge the PR once CI is green'])
  await $.turn.complete(done('t1', "I'll merge it once CI is green."))
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
  expect(book(w).items[0]).toEqual(expect.objectContaining({ state: 'done', closedBy: 'hand' }))
  await $.command.run({ command: 'ledger', args: 'clear' } as any)
  await clock.advance(10)
  expect(rec(w).ledger.open).toBe(0)
})
