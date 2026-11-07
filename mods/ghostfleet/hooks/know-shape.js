// The fleet's memory, third layer (docs/MEMORY.md): decisions a small model reads off a
// finished turn. Pure — the gate, the prompt and the parser — so test/run.sh can drive it
// with a stub for the model call and assert the one thing that must never happen: a call for
// a turn whose project is private. register.js (KNOW) supplies the real call.
//
// THE GATE FAILS CLOSED. The call goes ahead only when the switch is on AND the privacy
// answer is exactly `include`. A privacy lookup that failed, timed out or said anything else
// is no call: "I could not tell whether this is private" must read as private, because the
// cost of the other mistake is a private project's turn in a vendor's request log.

export const INFER_MODEL = 'haiku'
export const INFER_TOKENS = 600
export const INFER_MS = 30_000
export const INFER_CHARS = 6000           // the turn as shown: its end, where decisions are reported
export const INFER_MAX = 3                // facts kept from one turn

export const mayInfer = ({ enabled, mode }) => enabled === true && mode === 'include'

export function inferPrompt(turn) {
  const t = String(turn || '')
  const shown = t.length > INFER_CHARS ? `…${t.slice(-INFER_CHARS)}` : t
  return [
    'Below is what a coding agent wrote during one turn of work on a software project.',
    'List the DECISIONS it made or reported in this turn: a choice between alternatives that a',
    'teammate would want to know later ("chose X over Y", "kept X because Y", "will not do X").',
    'Not actions (ran tests, opened a file), not plans for later, not facts about the code.',
    `At most ${INFER_MAX}. Most turns contain none; then return an empty list.`,
    'Reply with JSON only: {"decisions":[{"decision":"<one sentence>","because":"<why, or empty>"}]}',
    '',
    '<turn>',
    shown,
    '</turn>',
  ].join('\n')
}

// The reply's JSON, wherever in the text it sits; anything that is not the asked shape is no
// facts rather than an error.
export function parseFacts(text) {
  const s = String(text || '')
  const i = s.indexOf('{'), j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return []
  let v
  try { v = JSON.parse(s.slice(i, j + 1)) } catch { return [] }
  const list = v && Array.isArray(v.decisions) ? v.decisions : []
  return list
    .filter(d => d && typeof d.decision === 'string' && d.decision.trim())
    .slice(0, INFER_MAX)
    .map(d => ({ text: d.decision.trim().slice(0, 300), why: typeof d.because === 'string' ? d.because.trim().slice(0, 300) : '' }))
}

// The whole pass, with the call handed in. Returns { facts, skipped?, failed? }; `call` is
// awaited only when the gate allows it.
export async function inferFacts({ enabled, mode, turn, call }) {
  if (!mayInfer({ enabled, mode })) return { facts: [], skipped: enabled !== true ? 'off' : `memory is ${mode || 'unknown'} here` }
  if (!String(turn || '').trim()) return { facts: [], skipped: 'empty turn' }
  const r = await call(inferPrompt(turn))
  if (!r || !r.isAnswered) return { facts: [], failed: r ? `${r.reason || 'no answer'}` : 'no result' }
  return { facts: parseFacts(r.text), usage: r.usage }
}
