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

type World = { files: Map<string, string>; runs: string[][]; stall: boolean }

function world(on: any, env: Record<string, string> = {}, record: object | null = BASE): World {
  const w: World = { files: new Map(), runs: [], stall: false }
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
    if (argv[0] === 'mv') { w.files.set(argv[3], w.files.get(argv[2]) ?? ''); w.files.delete(argv[2]) }
    if (argv[0] === 'rm') for (const f of argv.slice(2)) w.files.delete(f)
    const stdout = argv[0] === '/bin/sh' ? '4242\n' : argv[0].endsWith('fleet-inbox') ? 'w2  need-you  permission\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
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
