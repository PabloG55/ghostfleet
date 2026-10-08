// The GUARDS section against the engine (`claude plugin test mods/ghostfleet`).
//
// Beneath the plugin: a fleet dir and a config dir in memory, and a `process.run` that
// answers git, tmux, gh, fleet-answer and lib/mod-gate.mjs the way a worker's worktree,
// a main checkout or Jarvis's master would. Each guard is proved in both directions (the
// forbidden call refused, the ordinary one let through) and through its failure: a guard
// that throws or gets no answer DENIES.
import { test, expect, mock } from 'claude-code/testing'

const DIR = '/fleet'
const ID = 'sess-1'
const JDIR = '/jcfg'
const MAIN = '/w/acme-api'
const LINKED = '/w/acme-api-w1'

type Answer = { exitCode: number; stdout?: string; stderr?: string } | 'reject'
type World = { files: Map<string, string>; runs: string[][]; stdin: string[]; answer: (argv: string[]) => Answer | undefined }

function world(on: any, { slot = 'w1', cwd = LINKED, env = {} as Record<string, string> } = {}): World {
  const w: World = { files: new Map(), runs: [], stdin: [], answer: () => undefined }
  w.files.set(`${DIR}/${ID}.json`, JSON.stringify({ session_id: ID, sock: 'cf-acme-api', slot, status: 'idle', ts: 1 }))
  mock.env(on, { CLAUDE_FLEET_DIR: DIR, CLAUDE_FLEET_JARVIS_DIR: JDIR, HOME: '/home/u', TMUX_PANE: '%1', ...env })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: cwd }))
  on('fs.read', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: w.files.has(e.path) || [...w.files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: [...w.files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (e.init?.stdin !== undefined) w.stdin.push(e.init.stdin)
    const a = w.answer(argv) ?? gitAnswer(argv)
    if (a === 'reject') throw new Error(`${argv[0]}: command not found`)
    return { value: { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: a.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

// A linked worktree's git-dir sits under the main checkout's common dir; in the main
// checkout the two are the same path.
function gitAnswer(argv: string[]): Answer {
  if (argv[0] === 'git') {
    const dir = argv[2]
    const linked = dir === LINKED
    if (argv.includes('--show-toplevel')) return { exitCode: 0, stdout: `${dir}\n` }
    if (argv.includes('--git-dir')) return { exitCode: 0, stdout: linked ? `${MAIN}/.git/worktrees/w1\n` : `${MAIN}/.git\n` }
    if (argv.includes('--git-common-dir')) return { exitCode: 0, stdout: `${MAIN}/.git\n` }
    if (argv.includes('--abbrev-ref')) return { exitCode: 0, stdout: linked ? 'feat/w1\n' : 'staging\n' }
  }
  if (argv[0] === 'tmux') return { exitCode: 0, stdout: 'w1\n' }
  return { exitCode: 0 }
}

const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as any)
const denied = (r: any) => String(r.deny ?? (r.isError ? r.text : '') ?? '')
const ran = (w: World, re: RegExp) => w.runs.some(a => re.test(a.join(' ')))

function ok(on: any) {
  on('tool.call', () => ({ result: 'ran' }))
  on('tool.check', () => ({ decision: 'allow' }))
}

// ── the cheap path ──────────────────────────────────────────────────────────

test('an ordinary command in an ordinary session runs, and starts no process', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  ok(on)
  const r: any = await bash($, 'ls -la && git status')
  expect(denied(r)).toBe('')
  expect(w.runs.length).toBe(0)
})

// ── MERGE ───────────────────────────────────────────────────────────────────

test('a worker in a linked worktree may not merge its PR (Bash)', async ($, on) => {
  mock.clock(on)
  world(on)
  ok(on)
  const r: any = await bash($, 'gh pr merge 42 --squash')
  expect(denied(r)).toContain('a worker does not merge its own PR')
  expect(denied(r)).toContain('fleet-project set -s cf-acme-api workers-merge on')
})

test('nor through the API, nor through the MCP tool', async ($, on) => {
  mock.clock(on)
  world(on)
  ok(on)
  expect(denied(await bash($, 'gh api -X PUT repos/o/r/pulls/7/merge'))).toContain('the LEAD merges')
  const r: any = await $.tool.call({ tool: 'mcp__github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 7 } as any)
  expect(denied(r)).toContain('the LEAD merges')
})

test('the lead in the main checkout merges', async ($, on) => {
  mock.clock(on)
  world(on, { slot: 'master', cwd: MAIN })
  ok(on)
  expect(denied(await bash($, 'gh pr merge 42 --squash'))).toBe('')
})

test('"workers can merge" on for the project lets the worker merge', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.files.set(`${DIR}/cf-acme-api.workers-merge`, '')
  ok(on)
  expect(denied(await bash($, 'gh pr merge 42'))).toBe('')
})

test('…and a per-session -off still vetoes it', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.files.set(`${DIR}/cf-acme-api.workers-merge`, '')
  w.files.set(`${DIR}/cf-acme-api.w1.workers-merge-off`, '')
  ok(on)
  expect(denied(await bash($, 'gh pr merge 42'))).toContain('the LEAD merges')
})

test('a worker may not turn its own boundary on', async ($, on) => {
  mock.clock(on)
  world(on)
  ok(on)
  expect(denied(await bash($, 'fleet-project set -s cf-acme-api workers-merge on'))).toContain('does not change its own boundaries')
})

test('a sub-lead merges its child\'s PR into its own branch, and not its own PR upward', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.files.set(`${DIR}/cf-acme-api.w1-a.parent`, 'w1\n')
  w.files.set(`${DIR}/cf-acme-api.manifest.tsv`, `${LINKED}-a\tw1-a\tfeat/w1-a\t-\n`)
  ok(on)
  w.answer = a => a[0] === 'gh' ? { exitCode: 0, stdout: a.includes('9') ? 'feat/w1\tfeat/w1-a\n' : 'staging\tfeat/w1\n' } : undefined
  expect(denied(await bash($, 'gh pr merge 9 --squash'))).toBe('')
  expect(denied(await bash($, 'gh pr merge --squash'))).toContain('the LEAD merges')
})

test('FAIL CLOSED: a merge guard that cannot ask git refuses', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  ok(on)
  w.answer = a => (a[0] === 'git' ? 'reject' : undefined)
  const r: any = await bash($, 'gh pr merge 42')
  expect(denied(r)).toContain('a guard fails closed')
})

test('FAIL CLOSED: a sub-lead whose PR GitHub cannot name is refused', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.files.set(`${DIR}/cf-acme-api.w1-a.parent`, 'w1\n')
  w.files.set(`${DIR}/cf-acme-api.manifest.tsv`, `${LINKED}-a\tw1-a\tfeat/w1-a\t-\n`)
  ok(on)
  w.answer = a => (a[0] === 'gh' ? { exitCode: 1, stderr: 'no network' } : undefined)
  expect(denied(await bash($, 'gh pr merge 9'))).toContain('the LEAD merges')
})

// ── JARVIS ──────────────────────────────────────────────────────────────────

function jarvis(w: World) { w.files.set(`${JDIR}/jarvis`, 'name=jarvis\nsock=cf-acme-api\ncfg=/c\npath=/p\n') }
const gate = (a: string[]) => a[0] === 'node' && a[1].endsWith('/lib/mod-gate.mjs')

test('Jarvis\'s push is refused with the proposal the gate wrote', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 2, stderr: 'jarvis: Bash is on Jarvis\'s confirm-list … Recorded as proposal K7QM.' } : undefined)
  const r: any = await bash($, 'git push origin staging')
  expect(denied(r)).toContain('proposal K7QM')
  expect(w.runs.find(gate)?.slice(2)).toEqual(['jarvis-bash'])
  expect(w.stdin).toContain('git push origin staging')
})

test('…and after his yes the same call goes through', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 0 } : undefined)
  expect(denied(await bash($, 'git push origin staging'))).toBe('')
})

test('Jarvis\'s fleet_stop over MCP asks the gate with the call\'s own arguments', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 2, stderr: 'error: fleet_stop is on Jarvis\'s confirm-list' } : undefined)
  const r: any = await $.tool.call({ tool: 'mcp__ghostfleet__fleet_stop', session: 'w2', reclaim: true } as any)
  expect(denied(r)).toContain('confirm-list')
  expect(w.runs.find(gate)?.slice(2)).toEqual(['jarvis-mcp', 'fleet_stop'])
  expect(JSON.parse(w.stdin[0])).toEqual({ session: 'w2', reclaim: true })
})

test('FAIL CLOSED: a gate that gives no answer refuses Jarvis\'s call', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 1, stderr: 'node: crashed' } : undefined)
  expect(denied(await bash($, 'git push'))).toContain('a guard fails closed')
  w.answer = a => (gate(a) ? 'reject' : undefined)
  expect(denied(await $.tool.call({ tool: 'mcp__ghostfleet__fleet_stop', session: 'w2' } as any))).toContain('a guard fails closed')
})

test('Jarvis\'s ordinary command asks no gate, so a broken gate cannot lock its shell', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? 'reject' : undefined)
  expect(denied(await bash($, 'ls -la && npm test'))).toBe('')
  expect(w.runs.some(gate)).toBe(false)
  expect(denied(await bash($, 'git push'))).toContain('a guard fails closed')
})

test('a worker on Jarvis\'s fleet is not Jarvis: no gate', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'w2', cwd: MAIN })
  jarvis(w)
  ok(on)
  expect(denied(await bash($, 'git push origin feat/x'))).toBe('')
  expect(w.runs.some(gate)).toBe(false)
})

// ── APPROVE ─────────────────────────────────────────────────────────────────

test('an approving fleet_answer is refused with fleet-answer\'s own words', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 2, stderr: "fleet-answer: REFUSED — 'w2' is showing a PERMISSION dialog" } : undefined)
  const r: any = await $.tool.call({ tool: 'mcp__ghostfleet__fleet_answer', session: 'w2', text: '1' } as any)
  expect(denied(r)).toContain('PERMISSION dialog')
  expect(w.runs.find(gate)?.slice(2)).toEqual(['answer-mcp'])
})

test('…a decline goes through', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  ok(on)
  w.answer = a => (gate(a) ? { exitCode: 0 } : undefined)
  expect(denied(await $.tool.call({ tool: 'mcp__ghostfleet__fleet_answer', session: 'w2', text: '3' } as any))).toBe('')
})

test('Jarvis\'s answer he said yes to is not asked of fleet-answer again', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  jarvis(w)
  ok(on)
  w.answer = a => (gate(a) ? (a[2] === 'jarvis-mcp' ? { exitCode: 0, stdout: 'granted\n' } : { exitCode: 2, stderr: 'REFUSED' }) : undefined)
  expect(denied(await $.tool.call({ tool: 'mcp__ghostfleet__fleet_answer', session: 'w2', text: '1' } as any))).toBe('')
  expect(w.runs.filter(gate).map(a => a[2])).toEqual(['jarvis-mcp'])
})

test('fleet-answer in Bash is asked with --check and the same words', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  ok(on)
  w.answer = a => (a[0].endsWith('/bin/fleet-answer') ? { exitCode: 3, stderr: 'fleet-answer: REFUSED' } : undefined)
  const r: any = await bash($, "cd /tmp && fleet-answer -s cf-acme-api w2 '1'")
  expect(denied(r)).toContain('REFUSED')
  expect(w.runs.find(a => a[0].endsWith('/bin/fleet-answer'))?.slice(1)).toEqual(['--check', '-s', 'cf-acme-api', 'w2', '1'])
})

test('FAIL CLOSED: fleet-answer --check that cannot run refuses', async ($, on) => {
  mock.clock(on)
  const w = world(on, { slot: 'master', cwd: MAIN })
  ok(on)
  w.answer = a => (a[0].endsWith('/bin/fleet-answer') ? 'reject' : undefined)
  expect(denied(await bash($, 'fleet-answer w2 1'))).toContain('a guard fails closed')
})
