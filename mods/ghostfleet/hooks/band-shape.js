// What the lead's band says, as plain functions: no `$`, no I/O. test/run.sh imports this
// with node and renders it at every width it claims to fit.

// The grid's colours (bin/fleet-grid.mjs C: 203 red, 80 cyan, 114 green), so a state reads
// the same on the band as on the card.
export const COLOR = { need: '#ff5f5f', working: '#5fd7d7', green: '#87d787', red: '#ff5f5f' }

// A record's state for the band: the mod's while it is still being written (the same
// heartbeat rule as lib/mod-status.mjs, without the pid probe the mod cannot make), else the
// shell hook's `status`.
export const MOD_STALE_MS = 150_000
export function recordState(rec, nowMs) {
  if (!rec) return ''
  if (rec.source === 'mod' && rec.state && rec.mod && nowMs - (Number(rec.mod.hb) || 0) <= MOD_STALE_MS) return rec.state
  return String(rec.status || '')
}

// Who is on this lead's team, from the sessions alive on its socket:
//   master    every session but itself and the terminal tabs (`_term-…`, never a worker)
//   sub-lead  its children: the sessions whose <sock>.<child>.parent names it
// Anything else is not a lead and gets no band.
export function teamOf(me, alive, children) {
  if (me === 'master') return alive.filter(s => s !== 'master' && !s.startsWith('_'))
  if (children.length) return alive.filter(s => children.includes(s))
  return null
}

// The newest record per session name on this socket.
export function latestBySlot(records, sock) {
  const by = new Map()
  for (const r of records) {
    if (!r || r.sock !== sock || !r.slot) continue
    const prev = by.get(r.slot)
    if (!prev || (Number(r.ts) || 0) >= (Number(prev.ts) || 0)) by.set(r.slot, r)
  }
  return by
}

export function summarize(team, bySlot, nowMs) {
  let working = 0, need = 0
  for (const s of team) {
    const st = recordState(bySlot.get(s), nowMs)
    if (st === 'working') working++
    else if (st === 'need-you') need++
  }
  return { workers: team.length, working, need }
}

// `gh pr list --json headRefName,baseRefName,statusCheckRollup` reduced to what the band
// says. A PR is green when every check finished and none failed, red when any failed,
// pending otherwise (and when it has no checks at all: nothing has said it is green).
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
export function checkState(rollup) {
  const checks = Array.isArray(rollup) ? rollup : []
  if (!checks.length) return 'pending'
  let done = true
  for (const c of checks) {
    const v = String(c.conclusion || c.state || '').toUpperCase()
    if (FAILED.has(v)) return 'red'
    if (!PASSED.has(v)) done = false
  }
  return done ? 'green' : 'pending'
}

// Which PRs are this lead's: a sub-lead's are the ones INTO its branch (its children's);
// master's are the ones FROM a branch its fleet spawned (the manifest), whatever became of
// the session since — a finished worker's green PR is exactly what master is waiting on.
export function prSummary(prs, { me, branch, fleetBranches }) {
  const mine = (prs || []).filter(p => me === 'master'
    ? fleetBranches.includes(p.headRefName)
    : Boolean(branch) && p.baseRefName === branch)
  const out = { green: 0, red: 0, pending: 0 }
  for (const p of mine) out[checkState(p.statusCheckRollup)]++
  return out
}

// The band as text runs, the longest form that fits `columns`. The order is the brief's
// ("3 workers · 1 working · 1 need you · 2 PRs green") while there is room; as it narrows,
// words shorten, and below that `need you` moves first, since it is the one thing a lead
// must not miss and the right end is what a narrow pane cuts.
//   prs: undefined = not read yet (say nothing), null = could not read (`PRs ?`).
// A run is { text, color?, dim?, bold? }; groups are joined by ` · `, or a space when tight.
// `w` is workers wherever it is short: the band never says anything else with a w.
export function bandRuns(s, prs, columns) {
  if (!s) return null
  if (s.workers === 0 && !(prs && (prs.green || prs.red || prs.pending))) return null
  const cols = Math.max(1, Number(columns) || 80)
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`
  const need = t => s.need ? [{ text: t, color: COLOR.need, bold: true }] : null
  const busy = t => s.working ? [{ text: t, color: COLOR.working }] : null
  const team = t => [{ text: t, dim: true }]
  const forms = [
    [' · ', [team(n(s.workers, 'worker', 'workers')), busy(`${s.working} working`), need(`${s.need} need you`), ...prGroups(prs, 'long')]],
    [' · ', [team(n(s.workers, 'worker', 'workers')), busy(`${s.working} working`), need(`${s.need} need you`), ...prGroups(prs, 'short')]],
    [' · ', [need(`${s.need} need you`), busy(`${s.working} busy`), team(`${s.workers}w`), ...prGroups(prs, 'tight')]],
    [' · ', [need(`${s.need} need`), busy(`${s.working} busy`), team(`${s.workers}w`)]],
    [' ', [need(`${s.need} need`), team(`${s.workers}w`)]],
    [' ', [s.need ? need(`${s.need}!`) : team(`${s.workers}w`)]],
  ]
  let runs = null
  for (const [sep, groups] of forms) {
    runs = groups.filter(Boolean).flatMap((g, i) => (i ? [{ text: sep, dim: true }, ...g] : g))
    if (width(runs) <= cols) return runs
  }
  return runs
}

function prGroups(prs, form) {
  if (prs === undefined) return []
  if (prs === null) return [[{ text: 'PRs ?', dim: true }]]
  const green = { text: '', color: COLOR.green }, red = { text: '', color: COLOR.red }
  if (form === 'long') return [
    prs.green ? [{ ...green, text: `${prs.green} ${prs.green === 1 ? 'PR' : 'PRs'} green` }] : null,
    prs.red ? [{ ...red, text: `${prs.red} red` }] : null,
    prs.pending ? [{ text: `${prs.pending} pending`, dim: true }] : null,
  ]
  const bits = [
    prs.green ? { ...green, text: `${prs.green}✓` } : null,
    prs.red ? { ...red, text: `${prs.red}✗` } : null,
    form === 'short' && prs.pending ? { text: `${prs.pending}…`, dim: true } : null,
  ].filter(Boolean)
  if (!bits.length) return []
  const spaced = bits.flatMap((b, i) => (i ? [{ text: ' ' }, b] : [b]))
  return [form === 'short' ? [{ text: 'PRs ', dim: true }, ...spaced] : spaced]
}

// Cells, counting each code point as one: every glyph the band draws is narrow.
export function width(runs) { return (runs || []).reduce((k, r) => k + [...r.text].length, 0) }
export const plain = runs => (runs || []).map(r => r.text).join('')
