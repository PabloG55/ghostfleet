// The BAND section against the engine (`claude plugin test mods/ghostfleet`): a lead's
// team drawn above its prompt from the fleet's records, and nothing for a worker.
import { test, expect, mock } from 'claude-code/testing'

const DIR = '/fleet'
const ID = 'sess-1'
const NOW = 10_000_000

type World = { files: Map<string, string>; mtimes: Map<string, number>; runs: string[][]; alive: string; prs: string | null }

function world(on: any, slot: string): World {
  const w: World = { files: new Map(), mtimes: new Map(), runs: [], alive: 'master\nw1\nw2\nw3\n_term-master\n', prs: '[]' }
  const rec = (id: string, s: string, extra: object) =>
    w.files.set(`${DIR}/${id}.json`, JSON.stringify({ session_id: id, sock: 'cf-acme-api', slot: s, ts: 5, ...extra }))
  rec(ID, slot, { status: 'ready' })
  rec('a', 'w1', { status: 'idle', source: 'mod', state: 'working', mod: { hb: NOW - 1000 } })
  rec('b', 'w2', { status: 'need-you' })
  rec('c', 'w3', { status: 'ready' })
  // a stale mod state (no heartbeat for minutes) is not believed: the shell's status is
  rec('d', 'w9', { status: 'ready', source: 'mod', state: 'working', mod: { hb: NOW - 600_000 } })
  w.files.set(`${DIR}/cf-acme-api.manifest.tsv`, '/w/a\tw1\tfeat/a\t-\n/w/b\tw2\tfeat/b\t-\n')
  mock.env(on, { CLAUDE_FLEET_DIR: DIR, HOME: '/home/u' })
  on('session.id', () => ({ value: ID }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: '/w/acme-api' }))
  on('fs.read', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.write', (_$: any, e: any) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', (_$: any, e: any) => ({
    value: [...w.files.keys()].filter(k => k.startsWith(`${e.path}/`))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: w.mtimes.get(k) ?? w.files.get(k)!.length, isLink: false })),
  }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (argv[0] === 'mv') { w.files.set(argv[3], w.files.get(argv[2]) ?? ''); w.files.delete(argv[2]) }
    let stdout = '', exitCode = 0
    if (argv[0] === 'tmux') stdout = w.alive
    if (argv[0] === 'gh') { if (w.prs === null) exitCode = 1; else stdout = w.prs }
    if (argv[0] === 'git') stdout = 'feat/w1\n'
    if (argv[0] === '/bin/sh') stdout = '4242\n'
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return w
}

const PROPS = (bodyColumns: number) => ({
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 5 } },
})

async function band($: any, clock: any, columns = 90) {
  await $.session.start({ cwd: '/w/acme-api', surface: null, isInteractive: true })
  await clock.advance(10)
  await clock.advance(10)
  const out: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ghostfleet', surface, ...PROPS(columns) } as any)
    const texts = await ui.findAll({ type: 'Text' })
    out.push(texts.map((t: any) => t.text).join(''))
    await ui.unmount()
  }
  return out
}

test('master sees its team: workers, working, need you, and its PRs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'master')
  w.prs = JSON.stringify([
    { number: 1, headRefName: 'feat/a', baseRefName: 'staging', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    { number: 2, headRefName: 'feat/b', baseRefName: 'staging', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    { number: 3, headRefName: 'someone-else', baseRefName: 'staging', statusCheckRollup: [] },
  ])
  const [terminal, desktop] = await band($, clock)
  expect(terminal).toBe('3 workers · 1 working · 1 need you · 2 PRs green')
  expect(desktop).toBe(terminal)
})

test('a narrow band keeps "need you" first', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, 'master')
  const [terminal] = await band($, clock, 24)
  expect(terminal.startsWith('1 need')).toBe(true)
  expect([...terminal].length).toBeLessThanOrEqual(24)
})

test('when gh cannot answer, the band says PRs ?', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'master')
  w.prs = null
  const [terminal] = await band($, clock)
  expect(terminal).toContain('PRs ?')
})

test('a worker with no children draws no band, and never asks tmux or gh', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'w1')
  // What the engine draws when the mod passes: a marker the band would have replaced.
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'ENGINE') })
  const [terminal] = await band($, clock)
  expect(terminal).toBe('ENGINE')
  expect(w.runs.some(a => a[0] === 'tmux' || a[0] === 'gh')).toBe(false)
})

test('a sub-lead sees its children only, and the PRs into its branch', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'w1')
  w.alive = 'master\nw1\nw2\nw3\nw1-a\n'
  w.files.set(`${DIR}/cf-acme-api.w1-a.parent`, 'w1\n')
  w.files.set(`${DIR}/e.json`, JSON.stringify({ session_id: 'e', sock: 'cf-acme-api', slot: 'w1-a', status: 'need-you', ts: 5 }))
  w.prs = JSON.stringify([
    { number: 4, headRefName: 'feat/w1-a', baseRefName: 'feat/w1', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
    { number: 1, headRefName: 'feat/a', baseRefName: 'staging', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
  ])
  const [terminal] = await band($, clock)
  expect(terminal).toBe('1 worker · 1 need you · 1 red')
})

// The age is drawn against a minute bucket (so the band redraws once a minute), in seconds.
const MINUTE = Math.floor(NOW / 60_000) * 60

// hooks/fleet-event.sh holds a wake it cannot paste (the lead's box never read empty) and
// rewrites <sock>.<kind>.blocked on every retry. The band says so above the box that is the
// cause, and only while the file is fresh: a retry killed without its trap says nothing.
test('a held wake is drawn above the team, and a stale one is not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'master')
  const file = `${DIR}/cf-acme-api.notify.blocked`
  w.files.set(file, `${MINUTE - 725}\x1f1\x1fmaster\n`)
  w.mtimes.set(file, NOW - 5_000)
  const [terminal] = await band($, clock, 120)
  expect(terminal.startsWith('wake held 12m · this input box has unsent text')).toBe(true)
  expect(terminal).toContain('3 workers')
  w.mtimes.set(file, NOW - 600_000)
  const [stale] = await band($, clock, 120)
  expect(stale).not.toContain('held')
})

test("a sub-lead's held wake is its own, never master's", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 'w1')
  w.alive = 'master\nw1\nw1-a\n'
  w.files.set(`${DIR}/cf-acme-api.w1-a.parent`, 'w1\n')
  w.files.set(`${DIR}/cf-acme-api.notify.blocked`, `${MINUTE - 60}\x1f1\x1fmaster\n`)
  w.mtimes.set(`${DIR}/cf-acme-api.notify.blocked`, NOW)
  const [none] = await band($, clock, 120)
  expect(none).not.toContain('held')
  w.files.set(`${DIR}/cf-acme-api.w1.notify.blocked`, `${MINUTE - 60}\x1f2\x1fw1\n`)
  w.mtimes.set(`${DIR}/cf-acme-api.w1.notify.blocked`, NOW)
  const [mine] = await band($, clock, 120)
  expect(mine).toContain('wake held 1m · no input box is showing')
})
