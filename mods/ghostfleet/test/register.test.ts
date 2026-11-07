// The mod's hooks against the engine itself (`claude plugin test mods/ghostfleet`).
//
// Beneath the plugin sits a fleet dir in memory: `fs.read`/`fs.write` answer from a map,
// `process.run` performs the `mv` the record writer renames with and records every
// other command, and the clock is mocked so a stalled call can be proved bounded without
// waiting for it. Each test drives one event the way a session raises it and reads the
// record the shell hook would read next.
import { test, expect, mock } from 'claude-code/testing'

const DIR = '/fleet'
const ID = 'sess-1'
const FILE = `${DIR}/${ID}.json`
const BASE = { session_id: ID, sock: 'cf-acme-api', slot: 'w1', status: 'idle', ts: 1, cwd: '/w/acme-api' }

// `hang`: commands whose run never settles, as a run whose environment a reload dropped never
// does. `takeBack`: an entry the sender renames away in the instant the mod marks it submitted.
type World = { files: Map<string, string>; runs: string[][]; stall: boolean; submitted: any[]; commands: any[]; order: string[]; hang: Set<string>; takeBack: string }

function world(on: any, env: Record<string, string> = {}, record: object | null = BASE): World {
  const w: World = { files: new Map(), runs: [], stall: false, submitted: [], commands: [], order: [], hang: new Set(), takeBack: '' }
  if (record) w.files.set(FILE, JSON.stringify(record))
  mock.env(on, { CLAUDE_FLEET_DIR: DIR, HOME: '/home/u', ...env })
  // Ops answer `{ value }`; the engine's own events answer their result shape.
  on('session.id', () => ({ value: ID }))
  on('session.turns', () => ({ value: 0 }))
  on('fs.read', (_$: any, e: any) => {
    if (w.stall) return new Promise(() => {})
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$: any, e: any) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    w.order.push(`${String(argv[0]).split('/').pop()} ${argv[1] ?? ''}${e.init?.stdin !== undefined ? ` <${e.init.stdin}` : ''}`.trim())
    let exitCode = 0
    if (argv[0] === 'mv') {
      // `mv [-f|-n] src dst`: a rename, which fails when there is nothing to rename. The
      // handoff's claims and revokes are decided by exactly that failure.
      const [src, dst] = argv.slice(-2)
      if (w.takeBack && dst === `${src.slice(0, -'.taken'.length)}.sent` && src.endsWith(`/${w.takeBack}.taken`)) {
        w.files.set(`${src.slice(0, -'.taken'.length)}.revoked`, w.files.get(src) ?? ''); w.files.delete(src)
      }
      if (w.files.has(src)) { w.files.set(dst, w.files.get(src) ?? ''); w.files.delete(src) } else exitCode = 1
    }
    if (argv[0] === 'rm') for (const f of argv.slice(2)) w.files.delete(f)
    const stdout = argv[0] === '/bin/sh' ? '4242\n' : argv[0] === 'wc' ? '  17 x\n'
      : argv[0].endsWith('fleet-inbox') ? 'w2  need-you  permission\n' : ''
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: w.files.has(e.path) }))
  on('fs.list', (_$: any, e: any) => {
    const pre = `${e.path}/`
    const names = [...w.files.keys()].filter(f => f.startsWith(pre) && !f.slice(pre.length).includes('/'))
    return { value: names.map(f => ({ name: f.slice(pre.length), kind: 'file', size: 1 })) }
  })
  on('prompt.submit', (_$: any, e: any) => { w.submitted.push(e); w.order.push(`submit ${e.text}`); return { text: e.text } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  // A slash command the plugin runs: it runs and answers no text, as a skill does (its turn
  // follows). `no-such` is left unanswered, and the harness rejects that run as the host
  // rejects an unknown name (measured: "$.command.run: no command named /x in this session").
  on('command.run', (_$: any, e: any, next: any) => {
    if (e.command === 'no-such') return next(e)
    w.commands.push(e); w.order.push(`command /${e.command} ${e.args}`.trim())
    return w.hang.has(e.command) ? new Promise(() => {}) : {}
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return w
}

const rec = (w: World) => JSON.parse(w.files.get(FILE) ?? 'null')
const complete = (reason: 'answer' | 'aborted', agentId?: string) =>
  ({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason, ...(agentId ? { agentId } : {}) })

test('a turn reads working, then ready, from the mod', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(rec(w)).toEqual(expect.objectContaining({ status: 'working', state: 'working', source: 'mod', turnId: 't1', slot: 'w1' }))
  await $.turn.complete(complete('answer') as any)
  expect(rec(w).state).toBe('ready')
})

test('an Esc reads interrupted; a subagent finishing does not end the turn', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('answer', 'agent-7') as any)
  expect(rec(w).state).toBe('working')
  await $.turn.complete(complete('aborted') as any)
  expect(rec(w).state).toBe('interrupted')
})

// The dialog is read from the verdict that opens it (register.js says why not from
// classic.PermissionRequest): `ask` on a real call.
type Verdict = 'allow' | 'ask' | 'deny'
function verdicts(on: any, decision: Verdict) {
  on('tool.check', () => ({ decision }))
  on('tool.call', () => ({ result: 'ran' }))
}
const check = ($: any) => $.tool.check({ tool: 'Write', input: { file_path: 'notes.txt', content: 'hi' }, tool_use_id: 'u1' } as any)

test('an ask on a real call reads need-you, and the call resolving moves it back', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  verdicts(on, 'ask')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await check($)
  expect(rec(w).state).toBe('need-you')
  await $.tool.call({ tool: 'Write', file_path: 'notes.txt', content: 'hi', tool_use_id: 'u1' } as any)
  expect(rec(w).state).toBe('working')
})

test('an allow (bypass mode, a rule) is not a need', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  verdicts(on, 'allow')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await check($)
  expect(rec(w).state).toBe('working')
})

test('a bare verdict query (no tool_use_id) is never a need', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  verdicts(on, 'ask')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.check({ tool: 'Write', input: {} } as any)
  expect(rec(w).state).toBe('working')
})

test('with no record the mod writes nothing: the shell hook owns its existence', async ($, on) => {
  mock.clock(on)
  const w = world(on, {}, null)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(w.files.size).toBe(0)
})

test('the budget lands in the record with the moment its window resets', async ($, on) => {
  mock.clock(on, { now: 5_000_000 })
  const w = world(on)
  await $.session.measure({
    context: { tokens: 1000, window: 200000, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-07T18:00:00Z' }],
    changed: ['rateLimits'],
  } as any)
  expect(rec(w).usage).toEqual(expect.objectContaining({
    at: 5000,
    limits: { five_hour: { pct: 42.5, resets: Date.parse('2026-10-07T18:00:00Z') / 1000 } },
  }))
})

test('SessionEnd leaves no record behind, and nothing after it makes one', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } } as any)
  expect(w.files.has(FILE)).toBe(false)
  await $.turn.start({ text: 'late', turnId: 't9' })
  expect(w.files.has(FILE)).toBe(false)
})

test('/inbox runs fleet-inbox for the record\'s fleet, mid-turn or not', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: '/w/acme-api', surface: null, isInteractive: false })
  const out = await $.command.run({ command: 'inbox', args: '' } as any)
  expect(out.text).toContain('need-you')
  const call = w.runs.find(a => a[0].endsWith('/bin/fleet-inbox'))
  expect(call?.slice(1)).toEqual(['-s', 'cf-acme-api'])
})

test('a backgrounded process with no record names no fleet, whatever its env says', async ($, on) => {
  mock.clock(on)
  const w = world(on, { CLAUDE_JOB_DIR: '/jobs/1', CLAUDE_FLEET_SOCK: 'cf-billing-svc', CLAUDE_FLEET_SLOT: 'master' }, null)
  const out = await $.command.run({ command: 'fleet', args: '' } as any)
  expect(out.text).toContain('not in a fleet')
  expect(w.runs.some(a => a[0].endsWith('/bin/fleet-list'))).toBe(false)
})

// A probe a worker started from its Bash tool: the worker's pane, server and slot in its env,
// and a record the shell hook wrote with no slot because the process tree says it is nested.
test('a nested agent names no fleet, though its env is the worker\'s whole', async ($, on) => {
  mock.clock(on)
  const w = world(on, { TMUX: '/tmp/tmux-1/cf-acme-api,1,0', TMUX_PANE: '%3', CLAUDE_FLEET_SOCK: 'cf-acme-api', CLAUDE_FLEET_SLOT: 'w1' },
    { ...BASE, sock: '', slot: '', pane: '', nested_under: 4242 })
  const out = await $.command.run({ command: 'fleet', args: '' } as any)
  expect(out.text).toContain('not in a fleet')
  expect(w.runs.some(a => a[0].endsWith('/bin/fleet-list'))).toBe(false)
})

test('a stalled filesystem cannot hold a turn open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.stall = true
  let started = false
  const turn = $.turn.start({ text: 'go', turnId: 't1' }).then(r => { started = true; return r })
  await clock.advance(1000)
  expect(started).toBe(false)
  await clock.advance(5000)
  await turn
  expect(started).toBe(true)
})

// ── DELIVERY ────────────────────────────────────────────────────────────────
// fleet-send leaves <id>.json in <fleet dir>/<session_id>.handoff/; the mod claims it on
// its poll while idle, submits it as the person's own words, and names the turn it began.
const SPOOL = `${DIR}/${ID}.handoff`
const entry = (id: string, text: string, reply?: object) =>
  [`${SPOOL}/${id}.json`, JSON.stringify({ id, text, ...(reply ? { reply } : {}) })] as const
const start = ($: any) => $.session.start({ cwd: '/w/acme-api', surface: null, isInteractive: false })
const json = (w: World, f: string) => JSON.parse(w.files.get(f) ?? 'null')

test('an idle session takes a handed-over prompt and names the turn it started', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  expect(w.files.get(`${SPOOL}/.ready`)).toBe('4242\n')
  w.files.set(...entry('1000-1', 'run the tests'))
  await clock.advance(500)
  expect(w.submitted.map(e => [e.text, e.origin])).toEqual([['run the tests', expect.objectContaining({ kind: 'plugin', asUser: true })]])
  expect(w.files.has(`${SPOOL}/1000-1.json`)).toBe(false)
  await $.turn.start({ text: 'run the tests', turnId: 't7' })
  expect(json(w, `${SPOOL}/1000-1.done`)).toEqual(expect.objectContaining({ id: '1000-1', turnId: 't7' }))
  expect(w.files.has(`${SPOOL}/1000-1.taken`)).toBe(false)
  expect(rec(w).turnId).toBe('t7')
})

// A claim whose turn never comes, on a session that then sits idle: no turn.start will ever
// arrive to notice it, so the poll does. Before, `pending` stayed set and every later handoff
// waited out its claim window unclaimed, with no receipt saying why.
test('a claim whose turn never starts is written off on the poll, and the spool takes the next', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', 'wake up'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['wake up'])
  w.files.set(...entry('2000-1', 'the next one'))
  await clock.advance(60_000)
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  expect(w.submitted.map(e => e.text)).toEqual(['wake up'])
  await clock.advance(61_000)
  const r = json(w, `${SPOOL}/1000-1.done`)
  expect(r.error).toBe('its turn never started')
  expect(r.head).toBe('wake up')
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['wake up', 'the next one'])
})

test('a claim the sender took back is let go without a failure receipt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', 'wake up'))
  await clock.advance(500)
  // fleet-send gave up on it and renamed it away (a wake it then pasted)
  w.files.delete(`${SPOOL}/1000-1.sent`)
  await clock.advance(121_000)
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  w.files.set(...entry('2000-1', 'the next one'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['wake up', 'the next one'])
})

test('a plain prompt is submitted, never run as a command', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', 'fix the build, see /tmp/log for the error'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['fix the build, see /tmp/log for the error'])
  expect(w.commands).toEqual([])
})

// A brief that opens with a skill. The host refuses `prompt.submit` for a text beginning
// with "/", and that refusal used to be the receipt nobody read; the worker sat idle.
const commandTurn = (name: string, args: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`

test('a prompt that starts with a slash command runs as that command, and its receipt names the turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, {}, { ...BASE, transcript: '/t/sess-1.jsonl' })
  await start($)
  w.files.set(...entry('1000-1', '/some-skill redo the page\n\nkeep the colours  ', { sock: 'cf-toolbox', sess: 'master', dir: '/fleet' }))
  await clock.advance(500)
  expect(w.submitted).toEqual([])
  expect(w.commands.map(e => [e.command, e.args])).toEqual([['some-skill', 'redo the page\n\nkeep the colours']])
  // A person's own command in the same second is theirs, not this delivery's turn.
  await $.turn.start({ text: commandTurn('other-skill', 'x'), turnId: 't1' })
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  await $.turn.complete(complete('answer') as any)
  await $.turn.start({ text: commandTurn('some-skill', 'redo the page\n\nkeep the colours'), turnId: 't2' })
  expect(json(w, `${SPOOL}/1000-1.done`)).toEqual(expect.objectContaining({ id: '1000-1', turnId: 't2' }))
  expect(w.files.get(`${DIR}/cf-acme-api.w1.reply-to.armed`)).toBe('17\nturn t2\n')
  await clock.advance(20_000)
  expect(json(w, `${SPOOL}/1000-1.done`).ran).toBeUndefined()
})

test('a command that starts no turn is receipted as ran, not left to time out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', '/compact'))
  await clock.advance(500)
  expect(w.commands.map(e => [e.command, e.args])).toEqual([['compact', '']])
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  await clock.advance(10_500)
  expect(json(w, `${SPOOL}/1000-1.done`)).toEqual(expect.objectContaining({ id: '1000-1', ran: '/compact' }))
  // ...and the spool is free again for the next prompt.
  w.files.set(...entry('2000-1', 'next'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['next'])
})

test('a refused delivery names the error and the session it failed in', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', '/no-such arg'))
  await clock.advance(500)
  const r = json(w, `${SPOOL}/1000-1.done`)
  expect(r).toEqual(expect.objectContaining({ id: '1000-1', sock: 'cf-acme-api', slot: 'w1' }))
  expect(r.error).toContain('command.run')
  expect(r.turnId).toBeUndefined()
})

test('a // or a bare / names no command: refused in words, nothing run or submitted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', '//literal slash'))
  await clock.advance(500)
  expect(w.commands).toEqual([])
  expect(w.submitted).toEqual([])
  expect(json(w, `${SPOOL}/1000-1.done`).error).toContain('reword it')
})

test('the mod\'s own commands are refused, not reported as run: the host skips its own hooks', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', '/inbox'))
  await clock.advance(500)
  expect(w.commands).toEqual([])
  expect(json(w, `${SPOOL}/1000-1.done`).error).toContain('run fleet-inbox instead')
})

test('past the hour a delivered receipt is cleared, a failed one is kept for the inbox', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000_000 })
  const w = world(on)
  w.files.set(`${SPOOL}/1000-1.done`, JSON.stringify({ id: '1000-1', turnId: 't1' }))
  w.files.set(`${SPOOL}/1000-2.done`, JSON.stringify({ id: '1000-2', error: 'refused', sock: 'cf-acme-api', slot: 'w1' }))
  await start($)
  await clock.advance(500)
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  expect(w.files.has(`${SPOOL}/1000-2.done`)).toBe(false)
  expect(json(w, `${SPOOL}/1000-2.failed`).error).toBe('refused')
})

test('a running turn is never handed a prompt: it waits for the turn to end', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'the task in hand', turnId: 't1' })
  w.files.set(...entry('1000-1', 'next task'))
  await clock.advance(2000)
  expect(w.submitted).toEqual([])
  expect(w.files.has(`${SPOOL}/1000-1.json`)).toBe(true)
  await $.turn.complete(complete('answer') as any)
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['next task'])
})

test('one at a time, oldest first: the second waits for the first one\'s turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(...entry('2000-1', 'second'))
  w.files.set(...entry('1000-1', 'first'))
  await clock.advance(1500)
  expect(w.submitted.map(e => e.text)).toEqual(['first'])
  await $.turn.start({ text: 'first', turnId: 't1' })
  await $.turn.complete(complete('answer') as any)
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['first', 'second'])
})

test('a prompt revoked before the claim is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(`${SPOOL}/1000-1.revoked`, JSON.stringify({ id: '1000-1', text: 'pasted instead' }))
  await clock.advance(1000)
  expect(w.submitted).toEqual([])
})

test('the reply address is armed by THIS prompt\'s turn, not by one a person started first', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, {}, { ...BASE, transcript: '/t/sess-1.jsonl' })
  await start($)
  w.files.set(...entry('1000-1', 'what broke?', { sock: 'cf-toolbox', sess: 'master', dir: '/fleet' }))
  await clock.advance(500)
  await $.turn.start({ text: 'something the person typed', turnId: 't1' })
  expect(w.files.has(`${DIR}/cf-acme-api.w1.reply-to`)).toBe(false)
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  await $.turn.complete(complete('answer') as any)
  await $.turn.start({ text: 'what broke?', turnId: 't2' })
  expect(w.files.get(`${DIR}/cf-acme-api.w1.reply-to`)).toBe('cf-toolbox\x1fmaster\x1f/fleet\n')
  expect(w.files.get(`${DIR}/cf-acme-api.w1.reply-to.armed`)).toBe('17\nturn t2\n')
  expect(json(w, `${SPOOL}/1000-1.done`).turnId).toBe('t2')
})

test('an address that could close a quote is not armed', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', 'hi', { sock: 'cf-x"; rm', sess: 'master', dir: '/fleet' }))
  await clock.advance(500)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(w.files.has(`${DIR}/cf-acme-api.w1.reply-to`)).toBe(false)
  expect(json(w, `${SPOOL}/1000-1.done`).turnId).toBe('t1')
})

test('a claim a dead process left behind is delivered by the next one', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.files.set(`${SPOOL}/1000-1.taken`, JSON.stringify({ id: '1000-1', text: 'stranded' }))
  await start($)
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['stranded'])
})

// THE RELOAD THAT DELIVERED ITSELF. `/reload-plugins` handed over through the spool reloads this
// mod from inside its own command run: the old environment is dropped before that run settles
// (so its receipt is never written), and the new one starts on the same conversation. The run
// here never settles, as the dropped one never does, and the second session.start is the
// reload's. It used to find the claim, put it back, and run the reload again: a loop.
test('a command that reloads the mod mid-delivery runs once, and is receipted as ran by the reload', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.hang.add('reload-plugins')
  await start($)
  w.files.set(...entry('1000-1', '/reload-plugins'))
  await clock.advance(500)
  expect(w.commands.map(e => e.command)).toEqual(['reload-plugins'])
  await start($)                                   // the reload's own session.start
  await clock.advance(30_000)
  expect(w.commands.map(e => e.command)).toEqual(['reload-plugins'])
  expect(json(w, `${SPOOL}/1000-1.done`)).toEqual(expect.objectContaining({ id: '1000-1', ran: '/reload-plugins' }))
  expect([...w.files.keys()].filter(f => /1000-1\.(json|taken|sent)$/.test(f))).toEqual([])
  // ...and the spool is free again: the next prompt goes through, once.
  w.files.set(...entry('2000-1', 'next'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['next'])
})

// A prompt the last process submitted is waited for, not submitted again: its turn.start, when
// it comes in the new process, still names it. A claim it never submitted goes out once, after.
test('after a restart a submitted prompt is never resubmitted, and a claim never submitted is', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.files.set(`${SPOOL}/1000-1.sent`, JSON.stringify({ id: '1000-1', text: 'already in' }))
  w.files.set(`${SPOOL}/1000-2.taken`, JSON.stringify({ id: '1000-2', text: 'never sent' }))
  await start($)
  await clock.advance(500)
  expect(w.submitted).toEqual([])
  await $.turn.start({ text: 'already in', turnId: 't4' })
  expect(json(w, `${SPOOL}/1000-1.done`)).toEqual(expect.objectContaining({ id: '1000-1', turnId: 't4' }))
  expect(w.files.has(`${SPOOL}/1000-1.sent`)).toBe(false)
  await $.turn.complete(complete('answer') as any)
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['never sent'])
})

// The sender's takeback (fleet-send renames a wake it gave up on) races the submit's own rename:
// whichever lands first owns it. Lost by the mod, nothing is submitted and nothing receipted.
test('a claim the sender takes back before its submit is never submitted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.takeBack = '1000-1'
  await start($)
  w.files.set(...entry('1000-1', 'wake up'))
  await clock.advance(500)
  expect(w.submitted).toEqual([])
  await clock.advance(121_000)
  expect(w.files.has(`${SPOOL}/1000-1.done`)).toBe(false)
  w.files.set(...entry('2000-1', 'the next one'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['the next one'])
})

test('SessionEnd withdraws .ready, and the spool keeps what is waiting', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  w.files.set(...entry('1000-1', 'later'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID, resume: { id: ID } } as any)
  await clock.advance(2000)
  expect(w.files.has(`${SPOOL}/.ready`)).toBe(false)
  expect(w.files.has(`${SPOOL}/1000-1.json`)).toBe(true)
  expect(w.submitted).toEqual([])
})

// A PROMPT HANDED INTO JARVIS'S MASTER IS THE FLEET TALKING, and it is marked as such HERE, in
// the session that receives it, under the HOME its own event hook reads. fleet-send marked it
// in the SENDER's home, and a sender whose HOME was not Jarvis's (a test run that redirected
// it) left every one of its "ok"s to be read as the owner's yes. Marked before the submit,
// because the hook that consumes the mark runs on that submit. Not in any other session.
const JMARK = '/home/u/.config/ghostfleet/jarvis'
const delivered = (w: World) => w.order.filter(o => o.startsWith('fleet-jarvis delivered'))

test('a prompt it delivers into Jarvis\'s master is marked as the fleet\'s before it is submitted', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, {}, { ...BASE, sock: 'cf-jarvis', slot: 'master' })
  w.files.set(JMARK, 'name=jarvis\nsock=cf-jarvis\n')
  await start($)
  w.files.set(...entry('1000-1', 'ok'))
  await clock.advance(500)
  expect(delivered(w)).toEqual(['fleet-jarvis delivered <ok'])
  expect(w.order.indexOf('fleet-jarvis delivered <ok')).toBeLessThan(w.order.indexOf('submit ok'))
})

test('...and not into a worker of Jarvis\'s own fleet', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, {}, { ...BASE, sock: 'cf-jarvis', slot: 'w1' })
  w.files.set(JMARK, 'name=jarvis\nsock=cf-jarvis\n')
  await start($)
  w.files.set(...entry('1000-1', 'ok'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['ok'])
  expect(delivered(w)).toEqual([])
})

test('...a Jarvis switched off is no Jarvis', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, {}, { ...BASE, sock: 'cf-jarvis', slot: 'master' })
  w.files.set(JMARK, 'name=jarvis\nsock=cf-jarvis\n')
  w.files.set(`${JMARK}.enabled`, 'off\n')
  await start($)
  w.files.set(...entry('1000-1', 'ok'))
  await clock.advance(500)
  expect(w.submitted.map(e => e.text)).toEqual(['ok'])
  expect(delivered(w)).toEqual([])
})
