// What the mod writes, as plain functions of what the engine handed it: no `$`, no I/O.
//
// Kept apart from register.js so the suite can hold the record's shape to its readers
// without a Claude session (test/run.sh imports this file with node), and so the next
// phase reads the vocabulary here rather than in the middle of the hooks.

export const VERSION = '0.1.0'

// The fields the mod owns in a status record. hooks/fleet-event.sh rewrites the record
// on every event and carries exactly these forward; test/run.sh holds the two lists to
// each other, so a field added here and forgotten there goes red instead of vanishing
// on the next shell event.
export const MOD_FIELDS = ['source', 'state', 'turnId', 'mod', 'usage', 'ledger']

// The state words are the fleet's own (bin/fleet-grid.mjs's STATUS table), so a reader
// needs no translation:
//   working      a model turn is running
//   ready        the turn ended with an answer (or an error) and the prompt is free
//   interrupted  the person cut the turn short (Esc); it is waiting on them
//   need-you     a dialog is up that only a person can answer
//   idle         a session that has not had a turn yet
export const STATES = ['working', 'ready', 'interrupted', 'need-you', 'idle']

export const stateAfterTurn = reason => (reason === 'aborted' ? 'interrupted' : 'ready')

// Whether a tool.check verdict puts a real call in front of a person: `ask`, on a call
// the model made (it has a tool_use_id; a `$.tool.check` query has none).
export function asksAPerson(e, verdict) {
  return Boolean(e && e.tool_use_id && verdict && verdict.decision === 'ask')
}

// The state, merged into the record the shell hook wrote. `status` is set too, so a
// reader that only knows `status` sees the same word; `source` and `mod` are what let a
// reader decide whether to believe it (lib/mod-status.mjs).
export function withState(rec, state, { nowMs, pid, turnId }) {
  return {
    ...rec,
    ...(turnId ? { turnId } : {}),
    status: state,
    state,
    source: 'mod',
    ts: Math.floor(nowMs / 1000),
    mod: { v: VERSION, pid, hb: nowMs, at: nowMs },
  }
}

// An ISO timestamp as epoch seconds, so a shell reader compares it with `date +%s` and
// needs no date parser.
const epoch = iso => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

// `session.measure` (or `$.session.usage()`) as the record keeps it. Each window keeps
// the moment it resets beside its figure: within one window usage only rises, so a
// reading whose window has not reset is a true lower bound however old it is, and one
// whose window has reset describes nothing. That is the whole of what bin/fleet-governor
// needs to decide whether to believe it.
export function usageRecord(m, nowMs) {
  const limits = {}
  for (const w of m.rateLimits || []) {
    if (!w || typeof w.kind !== 'string') continue
    limits[w.kind] = { pct: w.percentUsed, resets: epoch(w.resetsAt) }
  }
  return {
    at: Math.floor(nowMs / 1000),
    context: { tokens: m.context?.tokens, window: m.context?.window, percent: m.context?.percent },
    limits,
    ...(m.cost ? { cost_usd: m.cost.usd } : {}),
  }
}

// The fleet socket named by $TMUX ("<socket path>,<server pid>,<session>"), when it is
// a fleet's (cf-*): the server this pane is on, which cannot go stale behind a
// long-running --resume the way an exported CLAUDE_FLEET_SOCK can.
export function sockOfTmux(tmux) {
  const server = String(tmux || '').split(',')[0].split('/').pop() || ''
  return server.startsWith('cf-') ? server : ''
}
