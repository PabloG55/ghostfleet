// ghostfleet's mod: the fleet's view of a Claude session, from inside the session.
//
// Everything the fleet knew about a Claude session it learned from OUTSIDE: a regex over
// the captured pane for "is it working" (blind at 56 columns, fooled by a leftover login
// line, by prose that quotes a spinner), the status bar scraped for the 5h budget (gone
// below ~100 columns, frozen on an idle pane), and a lead spending a whole turn to run
// fleet-inbox through Bash. From in here there is nothing to guess: a turn starts, a turn
// completes, a dialog is about to be drawn, the engine measures the account.
//
// Three things, each a section below, all sharing the record I/O at the top:
//   STATE     written into the session's status record as it changes
//   BUDGET    the account's rate-limit windows, from the engine's own measurement
//   COMMANDS  /fleet and /inbox, answered without a turn
// What is written is shaped by ./shape.js, plain functions the suite can run with node.
// The next phase adds a section and a line in `register`; the engine reads `$` only
// inside the file whose hooks use it, which is why this is one file and not four.
//
// EVERY HOOK HERE OBSERVES; none of them decides anything. A hook that throws or runs
// out of time is skipped and the session goes on as if this were not loaded, which is
// exactly right for an observer, so none carries a `.catch` that could refuse in its
// place. Nothing here touches the network or a model. Every file and process call is
// bounded (IO_MS), because a `$` call in flight does not count against a hook's budget
// and an unbounded one would hold a turn open for as long as the filesystem stalled.

import {
  withState, stateAfterTurn, usageRecord, sockOfTmux, asksAPerson,
} from './shape.js'

// ── the record ──────────────────────────────────────────────────────────────
//
// ONE RECORD, TWO WRITERS. hooks/fleet-event.sh has always written
// <fleet dir>/<session_id>.json, and every reader (the grid, the phone, the digest,
// fleet-list, the governor) already knows how to find it and scope it by socket. So the
// mod MERGES its fields into that record rather than starting a file beside it, and the
// shell hook carries them forward when it rewrites the file. A second file would be a
// second answer to "what is this session doing", and this repo has paid for that shape
// (two status files for one session, the stale one shadowing the live one).
//
// THE SHELL HOOK OWNS THE RECORD'S EXISTENCE. It resolves who the session is (the slot
// from the pane, a renamed pane, the predecessor of a backgrounded conversation) and it
// removes the record at SessionEnd. The mod never creates one: a patch with nothing to
// patch does nothing. Creating it here would re-derive that identity in a second
// language, and a write landing just after SessionEnd would resurrect an ended session
// as a "lost" card.

const IO_MS = 1500
const HEARTBEAT_MS = 60_000
const RUN_MS = 10_000

// The fleet dir, resolved exactly as hooks/fleet-event.sh resolves it, from the same
// environment, so the two writers can only ever be looking at the same file.
async function fleetDir($) {
  const explicit = await $.env.get('CLAUDE_FLEET_DIR')
  if (explicit) return explicit
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg}/fleet`
  return `${await $.env.get('HOME')}/.claude/fleet`
}

// Settles to what `work` settles to, or to `fallback` once `ms` has passed or `work`
// rejected. Never rejects, never waits longer than `ms`.
async function bounded($, work, ms, fallback) {
  const timeout = $.clock.sleep(ms).then(() => fallback, () => fallback)
  return Promise.race([Promise.resolve(work).catch(() => fallback), timeout])
}

async function readRecord($, file) {
  try {
    const rec = JSON.parse(await $.fs.read(file))
    return rec && typeof rec === 'object' ? rec : null
  } catch {
    return null
  }
}

async function ownRecord($) {
  return readRecord($, `${await fleetDir($)}/${await $.session.id()}.json`)
}

// Patches apply one at a time, in the order asked, so a heartbeat can never land between
// a state change's read and its write and undo it.
let queue = Promise.resolve()

// Applies `change(record)` to this session's record and writes the result atomically.
// `change` returns the new record, or null to leave the file alone. Resolves true when a
// write landed, false for every other outcome, failures included.
function patchRecord($, change) {
  const run = queue.then(() => bounded($, applyPatch($, change), IO_MS * 2, false))
  queue = run.then(() => undefined, () => undefined)
  return run
}

async function applyPatch($, change) {
  const id = await $.session.id()
  if (!id) return false
  const dir = await fleetDir($)
  const file = `${dir}/${id}.json`
  const rec = await readRecord($, file)
  if (!rec) return false
  const next = change(rec)
  if (!next) return false
  // Beside the record and renamed over it, as the shell hook writes: every reader skips
  // a record it cannot parse "because the hook writes atomically", and a torn read here
  // would cost the shell hook every field it carries forward. The leading dot keeps the
  // temporary file out of every `*.json` glob that reads the directory.
  const tmp = `${dir}/.${id}.mod.tmp`
  await $.fs.write(tmp, JSON.stringify(next))
  const moved = await $.process.run(['mv', '-f', tmp, file], { timeoutMs: IO_MS })
  return moved.exitCode === 0
}

// Who this session is in its fleet: the socket and slot its record carries (the shell
// hook resolved them); failing that, the environment, unless the environment is known
// not to be this session's.
//
// A BACKGROUNDED CONVERSATION RUNS UNDER SOMEBODY ELSE'S ENVIRONMENT (hooks/fleet-event.sh
// has the measurement): its process was spawned by the config dir's daemon, carries no
// $TMUX, and carries the CLAUDE_FLEET_* of whichever session first started that daemon.
// With $CLAUDE_JOB_DIR set and no $TMUX the environment names nobody, and only the
// record, which the shell hook pointed at the conversation's predecessor, may answer.
async function identity($, rec) {
  if (rec && rec.sock && rec.slot) return { sock: String(rec.sock), slot: String(rec.slot) }
  const tmux = await $.env.get('TMUX')
  const job = await $.env.get('CLAUDE_JOB_DIR')
  if (job && !tmux) return { sock: '', slot: '' }
  const sock = sockOfTmux(tmux) || (await $.env.get('CLAUDE_FLEET_SOCK')) || ''
  const slot = (await $.env.get('CLAUDE_FLEET_SLOT')) || ''
  return { sock, slot }
}

// ── STATE ───────────────────────────────────────────────────────────────────
//
// Written the moment it changes, with `source: "mod"`; readers prefer it over the pane
// while the process that wrote it is alive and its heartbeat is recent
// (lib/mod-status.mjs), and fall back to the pane regex otherwise.

let pid = 0
let state = ''
let heartbeat = null

async function setState($, next, turnId) {
  state = next
  const nowMs = await $.clock.now()
  return patchRecord($, rec => withState(rec, next, { nowMs, pid, turnId }))
}

// The process this module runs in. `$.process.run` starts its child from Claude Code's
// own process, so the child's parent is the pid a reader can probe; that is what makes
// a crash visible at once instead of after a missed heartbeat.
async function learnPid($) {
  const out = await bounded($, $.process.run(['/bin/sh', '-c', 'echo $PPID'], { timeoutMs: IO_MS }), IO_MS, null)
  const n = Number(String(out?.stdout || '').trim())
  return Number.isInteger(n) && n > 1 ? n : 0
}

async function startState($) {
  pid = await learnPid($)
  // A resumed conversation's record can still say `working` from the process that died
  // mid-turn; this process has started no turn, so say what it IS doing.
  const turns = await bounded($, $.session.turns(), IO_MS, 0)
  const first = turns > 0 ? 'ready' : 'idle'
  // The shell hook's SessionStart may not have written the record yet: try once more a
  // moment later, rather than creating it here.
  if (!(await setState($, first))) {
    $.clock.after(2000, () => { if (state === first) setState($, first) })
  }
  // A state can be right for hours (a ready session nobody talks to), so its age says
  // nothing about whether anybody is still writing it. The heartbeat is what lets a
  // reader tell "ready for an hour" from "the plugin was disabled an hour ago".
  if (heartbeat) heartbeat.cancel()
  heartbeat = $.clock.every(HEARTBEAT_MS, async () => {
    const nowMs = await $.clock.now()
    await patchRecord($, rec => (rec.mod && pid && rec.mod.pid === pid)
      ? { ...rec, mod: { ...rec.mod, hb: nowMs } } : null)
  })
}

async function onTurnStart($, e, next) {
  await setState($, 'working', e.turnId)
  return next(e)
}

// A subagent's turn completes too while the main turn runs on: only the main loop's end
// (no agentId) ends what the session is doing.
async function onTurnComplete($, e, next) {
  const done = await next(e)
  if (e.agentId === undefined) await setState($, stateAfterTurn(e.reason))
  return done
}

// THE PERMISSION DIALOG, FROM THE VERDICT THAT OPENS IT. The obvious events are
// classic.PermissionRequest and classic.Notification, and on this build neither reaches
// a user-tier mod: the debug log reads `ghostfleet: classic.PermissionRequest bypassed by
// cc-plugin-sec-default (tier user); beneath runs`, for both, every time. The harness
// cannot show that (it has no such plugin above the mod), which is how a hook that
// passed every test never fired once in a real session.
//   `tool.check` is the engine's own decision, and an `ask` on a real call (one with a
// tool_use_id, not a `$.tool.check` query) is the call being put to "the mode's decider".
// In manual, accept-edits and plan mode that decider is the dialog (measured: need-you
// within 2s of the turn starting, where the shell hook's Notification took 6). A bypass
// session's verdict is `allow`, so it never reads as need-you.
//   NOT HANDLED: in auto mode the decider is a classifier, so a classified call would read
// need-you until it resolves. A hook cannot read the permission mode on this build (the
// footer's SessionMode labels were measured empty through manual, accept-edits and plan)
// and auto mode was not available to measure, so no guess is coded here.
async function onToolCheck($, e, next) {
  const verdict = await next(e)
  if (asksAPerson(e, verdict)) await setState($, 'need-you')
  return verdict
}

// The call the dialog was about has run (or been refused): the turn is moving again.
// tool.call wraps the permission step and the tool, so this resolves after both.
async function onToolCall($, e, next) {
  const done = await next(e)
  if (state === 'need-you') await setState($, 'working')
  return done
}

// Inside SessionEnd's one short bound (1.5s for every hook together). No state is
// written: the shell hook removed the record a moment ago, and the only job here is to
// make sure a write that was already in flight has not put it back. So the queue is
// drained first and the record removed after it; anything queued later finds no record
// and, by the rule above, writes nothing.
async function onSessionEnd($, e, next) {
  if (e.reason !== 'clear' && heartbeat) { heartbeat.cancel(); heartbeat = null }
  state = ''
  const done = await next(e)
  await bounded($, queue, 500, null)
  const dir = await fleetDir($)
  await bounded($, $.process.run(['rm', '-f', `${dir}/${e.sessionId}.json`, `${dir}/.${e.sessionId}.mod.tmp`],
    { timeoutMs: 500 }), 500, null)
  return done
}

// ── BUDGET ──────────────────────────────────────────────────────────────────
//
// `session.measure` is the status bar's figure pushed rather than scraped: after each
// main-thread turn and whenever a window moves a whole point. bin/fleet-governor reads
// it from the record instead of the pane, which below ~100 columns carries no figure.

async function onMeasure($, e, next) {
  const nowMs = await $.clock.now()
  await patchRecord($, rec => ({ ...rec, usage: usageRecord(e, nowMs) }))
  return next(e)
}

// ── COMMANDS ────────────────────────────────────────────────────────────────
//
// A lead that wants its inbox asks the model, and the model spends a turn running
// fleet-inbox through Bash: an API round trip, a tool call, a permission check, and a
// wait behind whatever the lead was doing. These run the SAME commands (one copy of what
// the inbox is and of what "seen" means) as plain processes, `immediate`, so they
// answer mid-turn as well as at the prompt.
//
// THE MODEL READS THE OUTPUT: a command's `text` is a transcript row the model reads as
// well as the person. For /inbox that is the point. Running it marks the rows seen,
// exactly as fleet-inbox does, so if the model could not read them they would be gone
// from the one place it looks, and the lead would act on an inbox it never saw. /fleet
// is read for the same reason: "who is free" is the question asked right before a
// dispatch.

async function startCommands($) {
  await bounded($, Promise.all([
    $.command.register({ name: 'fleet', description: "This fleet's sessions and their states (no turn)", immediate: true }),
    $.command.register({ name: 'inbox', description: 'What needs the lead, marked seen as fleet-inbox does (no turn)', immediate: true }),
  ]), IO_MS, null)
}

// The commands ship beside the plugin: the runtime holds bin/ and mods/ side by side, so
// the copy that answers is the one cf-sync deployed with this module, never whichever
// fleet-inbox happens to be first on the session's PATH.
async function runFleet($, name) {
  const who = await identity($, await ownRecord($))
  if (!who.sock) return { text: `${name}: this session is not in a fleet (no socket in its record or its environment).` }
  // The identity rides in the environment as well as on -s: fleet-inbox decides WHOSE
  // inbox to read from CLAUDE_FLEET_SLOT, and in a backgrounded conversation the
  // inherited value is another session's.
  const env = { CLAUDE_FLEET_SOCK: who.sock, CLAUDE_FLEET_SLOT: who.slot }
  const argv = [`${$.plugin.root}/../../bin/${name}`, '-s', who.sock]
  const out = await bounded($, $.process.run(argv, { env, timeoutMs: RUN_MS }), RUN_MS + 1000, null)
  if (!out) return { text: `${name}: did not answer within ${RUN_MS / 1000}s.` }
  const text = [out.stdout, out.stderr].map(s => String(s || '').trimEnd()).filter(Boolean).join('\n')
  return { text: text || `${name}: (no output)` }
}

async function onFleet($) { return runFleet($, 'fleet-list') }
async function onInbox($) { return runFleet($, 'fleet-inbox') }

// ── wiring ──────────────────────────────────────────────────────────────────

async function onSessionStart($, e, next) {
  const started = await next(e)
  await startState($)
  await startCommands($)
  return started
}

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', onSessionStart)
  on('turn.start', onTurnStart)
  on('turn.complete', onTurnComplete)
  on('tool.check', onToolCheck)
  on('tool.call', onToolCall)
  on('session.end', onSessionEnd)
  on('session.measure', onMeasure)
  on('command.run', { command: 'fleet' }, onFleet)
  on('command.run', { command: 'inbox' }, onInbox)
}
