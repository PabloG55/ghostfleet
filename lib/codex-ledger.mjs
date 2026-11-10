#!/usr/bin/env node
// The ledger for a codex session: what the person asked it, kept the way the Claude mod keeps
// it (mods/ghostfleet/hooks/ledger.js, through register.js), from codex's own hooks.
//
//   codex-ledger.mjs prompt    <fleet dir> <thread id> <turn id>   stdin: the prompt
//   codex-ledger.mjs settle    <fleet dir> <thread id> <turn id>   stdin: the turn's last message
//   codex-ledger.mjs interrupt <fleet dir> <thread id> <turn id>
//
// hooks/codex-fleet-event.sh runs `prompt` at UserPromptSubmit and prints what this prints as
// the prompt's context (codex accepts additionalContext there, measured on 0.166.0); `settle`
// at Stop; `interrupt` at Interrupt, which is what an Esc fires instead of a Stop.
//
// THE SAME FILE AND THE SAME FUNCTIONS. <fleet dir>/<thread id>.ledger is what fleet-ledger
// reads and closes (it resolves a slot to its newest record, whose session_id the bridge sets
// to the thread id), and every change goes through ledger.js's pure functions, as the mod's
// do: addPrompt at the prompt, settleTurn at every turn end, markInterrupted for an Esc.
//
// WHAT CODEX DOES NOT GET: THE JUDGE. The mod asks a small model, at each turn end, which open
// items the turn answered (register.js judgeTurn, through the Claude Code host's model call).
// Nothing outside Claude Code has that call, so here an item closes only when the session
// closes it (`fleet-ledger close <id> "<proof>"`, which the note itself tells it to run), the
// person does, or it ages off the note (ledger.js BAND_DAYS). An ask the turn answered in prose
// stays listed on the next prompt until then.
//
// ONE PIECE OF THE MOD'S MEMORY LIVES IN A FILE HERE. The mod remembers, between turns, that
// the last one ended on a numbered question, so the person's bare "2" folds into the item that
// question was about instead of becoming an item of its own (ledger.js foldReply). A hook is a
// new process every time, so that is `.<thread id>.ledger.choice` beside the ledger, written at
// a Stop that ends on a choice and removed at every other turn end. Dot-led, as fleet-ledger's
// temp files are, so no glob of the fleet dir reads it.
//
// Fails quiet: a ledger that cannot be read or written costs the item, never the turn, and
// nothing is printed unless the note is whole. CLAUDE_FLEET_LEDGER=off turns all of it off, as
// it does for the mod; CLAUDE_FLEET_NOW_MS pins the clock, as it does for fleet-ledger.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as L from '../mods/ghostfleet/hooks/ledger.js'

const [verb, dir, id, turn = ''] = process.argv.slice(2)
const cfg = L.ledgerConfig(k => process.env[k])
if (!cfg.on || !dir || !id || !/^[A-Za-z0-9._-]+$/.test(id)) process.exit(0)
const now = Number(process.env.CLAUDE_FLEET_NOW_MS) || Date.now()
const file = L.ledgerFile(dir, id)
const choiceFile = path.join(dir, `.${id}.ledger.choice`)
const stdin = () => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }

// The memory hears every change, as it does from the mod and from fleet-ledger. Optional: a
// runtime without lib/know.mjs, or a broken one, costs the fact, never the write.
let K = null
try { K = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), 'know.mjs')) } catch {}

// fleet-ledger's write, made the same way: against the file as it is, beside it, renamed over
// it, and made again when the file moved meanwhile (fleet-ledger closes items from outside).
function change(fn) {
  for (let k = 0; k < 5; k++) {
    let before = ''
    try { before = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') return null }
    const cur = L.parseLedger(before)
    const next = fn(cur)
    if (!next) return cur
    const tmp = path.join(dir, `.${id}.ledger.codex.${process.pid}.tmp`)
    try {
      fs.writeFileSync(tmp, JSON.stringify(next))
      let again = ''
      try { again = fs.readFileSync(file, 'utf8') } catch {}
      if (again === before) {
        fs.renameSync(tmp, file)
        try { K && K.noteLedger(dir, id, L.ledgerChanges(cur, next), 'codex') } catch {}
        return next
      }
      fs.rmSync(tmp, { force: true })
    } catch { try { fs.rmSync(tmp, { force: true }) } catch {} return null }
  }
  return null
}

function readChoice() {
  try { const c = JSON.parse(fs.readFileSync(choiceFile, 'utf8')); return c && typeof c === 'object' ? c : {} } catch { return {} }
}

if (verb === 'prompt') {
  const text = stdin()
  // A slash command is the harness's and carries nothing (register.js ledgerPromptSubmit).
  if (!text.trim() || text.trimStart().startsWith('/')) process.exit(0)
  // Typed into codex's composer, which is what the mod's `composer` origin is. A nudge, and a
  // message with no request in it, make no item (sourceOf, addPrompt).
  const source = L.sourceOf({ text, origin: { kind: 'composer' } })
  const choice = readChoice()
  let cur = null
  if (source) {
    // codex's UserPromptSubmit already carries the turn this prompt starts, so the items are
    // made with it: the mod's addPrompt-then-stampTurn, in one step.
    cur = change(l => L.addPrompt(l, {
      text, at: now, turnId: turn, source, queued: false,
      choiceTurn: choice.turnId || '', asked: choice.asked || '',
    }))
  }
  if (!cur) { try { cur = L.parseLedger(fs.readFileSync(file, 'utf8')) } catch { cur = null } }
  const notes = cur ? L.promptNotes(cur, text, now) : []
  if (notes.length) process.stdout.write(notes.join('\n\n'))
  process.exit(0)
}

if (verb === 'settle' || verb === 'interrupt') {
  const answer = verb === 'settle' ? stdin() : ''
  if (verb === 'interrupt' && turn) change(l => L.markInterrupted(l, turn, now))
  // Whatever the turn did, it is over: what it left open is owed from here (ledger.js
  // settleTurn). startedAt 0 is the mod's own answer for a turn whose start it did not see.
  if (turn) change(l => L.settleTurn(l, { turnId: turn, startedAt: 0 }))
  if (verb === 'settle' && turn && L.endsOnChoice(answer)) {
    try { fs.writeFileSync(choiceFile, JSON.stringify({ turnId: turn, asked: L.askedIn(answer) })) } catch {}
  } else {
    try { fs.rmSync(choiceFile, { force: true }) } catch {}
  }
  process.exit(0)
}
process.exit(0)
