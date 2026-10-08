// ghostfleet's mod: the fleet's view of a Claude session, from inside the session.
//
// Everything the fleet knew about a Claude session it learned from OUTSIDE: a regex over
// the captured pane for "is it working" (blind at 56 columns, fooled by a leftover login
// line, by prose that quotes a spinner), the status bar scraped for the 5h budget (gone
// below ~100 columns, frozen on an idle pane), and a lead spending a whole turn to run
// fleet-inbox through Bash. From in here there is nothing to guess: a turn starts, a turn
// completes, a dialog is about to be drawn, the engine measures the account.
//
// Seven things, each a section below, all sharing the record I/O at the top:
//   STATE     written into the session's status record as it changes
//   BUDGET    the account's rate-limit windows, from the engine's own measurement
//   COMMANDS  /fleet and /inbox, answered without a turn
//   DELIVERY  the fleet's prompts, submitted as turns of their own
//   GUARDS    the fleet's refusals in front of Bash and the MCP tools, failing CLOSED
//   BAND      a lead's team above its prompt
//   LEDGER    every request made of the session, held open until a final message answers it
// What is written is shaped by ./shape.js, ./handoff.js, ./guard-shape.js, ./band-shape.js and ./ledger.js,
// plain functions the suite can run with node. The engine follows `$` only into functions
// declared in this file, never across an import, which is why the hooks are one file and not six.
//
// THE OBSERVERS DECIDE NOTHING, THE GUARDS DECIDE AND FAIL CLOSED. STATE, BUDGET, COMMANDS
// and BAND only observe: a hook of theirs that throws or runs out of time is skipped and the
// session goes on as if this were not loaded, which is exactly right for an observer, so none
// carries a `.catch` that could refuse in its place. GUARDS is the one section whose hooks
// refuse, and each is registered with a `.catch` that refuses too (that section says why).
// DELIVERY acts, but only on prompts the fleet already decided to send: it refuses nothing,
// and a failure there leaves the prompt for fleet-send to paste. LEDGER is a nag, not a
// guard: it observes, and its one act (a single re-prompt per item) fails OPEN.
// Nothing here touches the network. The one model call is LEDGER's judge, made only when a
// turn left something to judge. Every file and process call is bounded
// (IO_MS), because a `$` call in flight does not count against a hook's budget and an
// unbounded one would hold a turn open for as long as the filesystem stalled.

import {
  withState, stateAfterTurn, usageRecord, sockOfTmux, asksAPerson,
} from './shape.js'
import {
  mergesAPr, changesABoundary, isMergeTool, prSelector, boundaryOn, mergeRefusal,
  SETTING_REFUSAL, failedClosed, answerCalls, JARVIS_TOOLS, fleetTool, callArgs, markerSock,
  jarvisMightAct,
} from './guard-shape.js'
import { teamOf, latestBySlot, summarize, prSummary, bandRuns } from './band-shape.js'
import {
  ledgerFile, parseLedger, ledgerConfig, sourceOf, openItems, ledgerSummary,
  soundsLikeAPromise, judgePrompt, parseVerdict, applyVerdict, gateTargets, gatePrompt,
  markGated, closeByHand, clearOpen, listing, ledgerRuns, stampTurn, withdrawn, dropItems, turnBlocks,
  judgeBatches, JUDGE_TOKENS,
  markInterrupted, addPrompt, closeByAgent, dropByAgent, addByAgent, contextNote, TOOL,
} from './ledger.js'
import {
  spoolOf, entryId, waiting, staleReceipts, replyOf, replyMarker, armedMarker, isTurnOf,
} from './handoff.js'

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
  currentTurn = e.turnId
  turnsStarted++
  await setState($, 'working', e.turnId)
  await deliveryTurnStart($, e)
  await ledgerTurnStart($, e)
  return next(e)
}

// A subagent's turn completes too while the main turn runs on: only the main loop's end
// (no agentId) ends what the session is doing.
async function onTurnComplete($, e, next) {
  const done = await next(e)
  if (e.agentId === undefined) await setState($, stateAfterTurn(e.reason))
  deliveryTurnComplete(e)
  // Not awaited: the judge is a model call, and the turn's end must not wait on it.
  if (e.agentId === undefined) void ledgerTurnComplete($, e, takeSteps(e)).catch(() => {})
  return done
}

// Every step's text is passed through untouched and noted for the ledger's judge, which
// reads the whole turn (see turnBlocks in ./ledger.js). A subagent's steps are its own.
async function* onTurnStep($, e, next) {
  const r = yield* next(e)
  if (e.agentId === undefined && r && r.answer) noteStep(e.turnId, r.answer)
  return r
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
  return ledgerNoteOnTool($, done)
}

// Inside SessionEnd's one short bound (1.5s for every hook together). No state is
// written: the shell hook removed the record a moment ago, and the only job here is to
// make sure a write that was already in flight has not put it back. So the queue is
// drained first and the record removed after it; anything queued later finds no record
// and, by the rule above, writes nothing.
async function onSessionEnd($, e, next) {
  if (e.reason !== 'clear' && heartbeat) { heartbeat.cancel(); heartbeat = null }
  state = ''
  await deliveryEnd($)
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

// ── DELIVERY ────────────────────────────────────────────────────────────────
//
// The fleet's prompts submitted from in here, not typed into the pane. bin/fleet-send
// used to deliver the way a person would: paste into the input box, press Enter. Each of
// its known failures came from standing outside: a paste glued onto a half-typed message
// (hence the empty-composer guards and deferrals), an Enter that raced the paste and
// never submitted ("could not confirm submit"), a prompt pasted into a busy session
// folded into the running turn so the next Stop belonged to work nobody asked for (hence
// arming reply-to on UserPromptSubmit). From in here it is one call, `$.prompt.submit`,
// which leaves the person's draft alone, runs as a turn of its own, and whose turn this
// section can name exactly.
//
// THE CHANNEL IS A SPOOL DIRECTORY PER SESSION, polled (./handoff.js has the layout).
// Claude Code's cross-session messaging was the other candidate and loses on each count
// that matters here: its sender has to be a Claude session, and fleet-send is run by a
// shell, by codex, by opencode, by the phone server; its registry is per config dir, so a
// lead on another profile cannot address it; it lands framed as a peer's message rather
// than as the prompt; and one in flight when the mod reloads is gone. A file is written
// by anything, survives a reload, a crash and a restart, and orders by name. The cost is
// latency, one poll period at worst (POLL_MS), against a turn that takes seconds.
//
// EACH STEP IS A RENAME, so exactly one side owns an entry at any moment:
//   fleet-send writes <id>.json and waits for <id>.done;
//   this claims it (.json -> .taken) only while no turn runs, and submits it; at the
//     turn.start whose text is that prompt it writes <id>.done with the turnId and arms
//     the prompt's reply address, if it has one, for THAT turn;
//   fleet-send, finding the entry unclaimed when its window closes, takes it back
//     (.json -> .revoked) and pastes. The loser of a rename knows it lost, so a prompt is
//     never both submitted and pasted.
//
// NOT HERE: the queue, and --now. A prompt for a busy session still goes to fleet-send's
// <sock>.<slot>.queue, counted on the card and drained by the shell hook's Stop through
// fleet-send, which hands each one here: one queue, one order, and a mod that dies with
// prompts waiting leaves them where the shell drain finds them. --now still pastes: the
// API runs a plugin's prompt as its own turn, once idle, and the only way into a running
// turn is a peer's message, which the model reads as somebody else's words.
//
// Fails open like the rest: a section that never claims costs the sender its window,
// then the paste it would have made anyway.

const POLL_MS = 500
// How long a claimed prompt may take to reach its turn.start before it is written off: the
// engine runs it "once idle", and a person's own turn can put that off.
const START_MS = 120_000

let turnRunning = false
let pending = null                         // { id, text, reply, at }: submitted, not started
let claiming = false
let poll = null
let spool = ''
let deliverSid = ''

const runBounded = ($, argv, ms = IO_MS) =>
  bounded($, $.process.run(argv, { timeoutMs: ms }), ms + 500, null)

async function writeSpool($, dir, name, text) {
  const tmp = `${dir}/.${name}.tmp`
  await bounded($, $.fs.write(tmp, text), IO_MS, null)
  const moved = await runBounded($, ['mv', '-f', tmp, `${dir}/${name}`])
  return moved?.exitCode === 0
}

async function receipt($, id, fields) {
  const nowMs = await $.clock.now()
  await writeSpool($, spool, `${id}.done`, JSON.stringify({ id, ...fields, at: nowMs }))
  await runBounded($, ['rm', '-f', `${spool}/${id}.taken`])
}

// One at a time, and only while idle: a prompt claimed mid-turn would sit inside the
// engine, where fleet-send can no longer take it back and nothing shows it waiting.
async function deliverTick($) {
  if (claiming || pending || turnRunning || !spool) return
  claiming = true
  try {
    const entries = await bounded($, $.fs.list(spool), IO_MS, null)
    if (!entries) return
    const nowMs = await $.clock.now()
    const old = staleReceipts(entries, nowMs)
    if (old.length) void runBounded($, ['rm', '-f', ...old.map(n => `${spool}/${n}`)])
    const id = waiting(entries)[0]
    if (!id) return
    const took = await runBounded($, ['mv', `${spool}/${id}.json`, `${spool}/${id}.taken`])
    if (took?.exitCode !== 0) return                     // revoked under us: it is theirs
    const entry = await readRecord($, `${spool}/${id}.taken`)
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) {
      await receipt($, id, { error: 'unreadable entry' })
      return
    }
    // `kind: "nudge"`: a wake-up fleet-send was told is one (--nudge), never a request.
    pending = { id, text: entry.text, reply: replyOf(entry), at: nowMs, nudge: entry.kind === 'nudge' }
    // The ledger's item for it is made HERE: a plugin's own submit passes every prompt.submit
    // hook but its own, so LEDGER's never sees it.
    await ledgerDelivery($, pending)
    // Settles once the turn started or the engine queued it; turn.start is what names the
    // turn, so this is not awaited for that. A refusal is answered here.
    const settled = r => (r && r.drop !== undefined ? { dropped: String(r.drop) } : null)
    const lost = async () => { if (pending?.ledgered?.length) await ledgerUndo($, pending.ledgered) }
    Promise.resolve($.prompt.submit({ text: entry.text, asUser: true })).then(
      async r => { const d = settled(r); if (d && pending?.id === id) { await lost(); pending = null; await receipt($, id, d) } },
      async err => { if (pending?.id === id) { await lost(); pending = null; await receipt($, id, { error: String(err?.message || err) }) } })
  } finally {
    claiming = false
  }
}

// THE REPLY ADDRESS, ARMED BY THE TURN ITSELF. hooks/fleet-event.sh relays the answer on
// the Stop of an armed address, and for a pasted prompt arms it on the next
// UserPromptSubmit, which is right only if that submit was this prompt. Here the turn is
// known: the address is written and armed together at its turn.start, with the transcript
// offset (the relay reads the answer from after it) and the turnId, which tells the hook
// not to re-arm on a prompt somebody types into this turn.
async function armReply($, reply, turnId) {
  const dir = await fleetDir($)
  const rec = await readRecord($, `${dir}/${deliverSid}.json`)
  if (!rec || !rec.sock || !rec.slot) return
  let lines = 0
  if (rec.transcript) {
    const wc = await runBounded($, ['wc', '-l', String(rec.transcript)])
    lines = Number(String(wc?.stdout || '').trim().split(/\s+/)[0]) || 0
  }
  const base = `${rec.sock}.${rec.slot}.reply-to`
  await writeSpool($, dir, base, replyMarker(reply))
  await writeSpool($, dir, `${base}.armed`, armedMarker(lines, turnId))
}

// The turn the claimed prompt started is the first main-loop turn.start carrying its text.
// One that starts first with other text (a person typing in the same second) is theirs,
// and the prompt goes on waiting for its own.
async function deliveryTurnStart($, e) {
  turnRunning = true
  const p = pending
  if (isTurnOf(p, e.text)) {
    pending = null
    await bounded($, (async () => {
      if (p.reply) await armReply($, p.reply, e.turnId)
      await receipt($, p.id, { turnId: e.turnId })
      // Recorded at its prompt.submit when that hook saw it (so its note could name it);
      // stamped with its turn here. A nudge is never an item.
      if (p.ledgered) await stampItems($, p.ledgered, e.turnId)
      if (p.ledgered && p.ledgered.length) noteDue = e.turnId
      else if (!p.nudge) await ledgerFleetItem($, p.text, e.turnId)
    })(), IO_MS * 4, null)
  } else if (p && (await $.clock.now()) - p.at > START_MS) {
    pending = null
    await bounded($, receipt($, p.id, { error: 'its turn never started' }), IO_MS * 2, null)
  }
}

function deliveryTurnComplete(e) {
  if (e.agentId === undefined) turnRunning = false
}

async function deliveryStart($) {
  await bounded($, (async () => {
    const sid = await $.session.id()
    if (!sid || !pid) return
    const dir = spoolOf(await fleetDir($), sid)
    await runBounded($, ['mkdir', '-p', dir])
    // A claim an earlier process of this conversation made and never finished goes back,
    // so the next tick delivers it instead of leaving it stranded as `.taken`.
    for (const t of (await bounded($, $.fs.list(dir), IO_MS, null)) || []) {
      const id = t && t.kind === 'file' ? entryId(t.name, '.taken') : null
      if (id) await runBounded($, ['mv', '-n', `${dir}/${id}.taken`, `${dir}/${id}.json`])
    }
    spool = dir
    deliverSid = sid
    pending = null
    turnRunning = false
    await writeSpool($, dir, '.ready', `${pid}\n`)
    if (poll) poll.cancel()
    poll = $.clock.every(POLL_MS, () => { void deliverTick($) })
  })(), IO_MS * 6, null)
}

// The spool stays (a prompt in it is somebody's); only this process's claim on it ends.
async function deliveryEnd($) {
  if (poll) { poll.cancel(); poll = null }
  const dir = spool
  spool = ''
  deliverSid = ''
  if (dir) await bounded($, $.process.run(['rm', '-f', `${dir}/.ready`], { timeoutMs: 400 }), 450, null)
}

// ── wiring ──────────────────────────────────────────────────────────────────

async function onSessionStart($, e, next) {
  const started = await next(e)
  await startState($)
  await startCommands($)
  await ledgerStart($)
  startBand($)
  await deliveryStart($)
  return started
}

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', onSessionStart)
  on('turn.start', onTurnStart)
  on('turn.step', onTurnStep)
  on('turn.complete', onTurnComplete)
  on('tool.check', onToolCheck)
  on('tool.call', onToolCall)
  on('session.end', onSessionEnd)
  on('session.measure', onMeasure)
  on('command.run', { command: 'fleet' }, onFleet)
  on('command.run', { command: 'inbox' }, onInbox)
  // GUARDS and BAND, below the wiring so each is one section of its own.
  on('tool.call', { tool: 'Bash' }, onBash).catch(bashFailedClosed)
  on('tool.call', { tool: /^mcp__/ }, onMcp).catch(mcpFailedClosed)
  on('ui.render', { component: 'AbovePrompt' }, onBandRender)
  on('prompt.submit', onPromptSubmit)
  on('command.run', { command: 'ledger' }, onLedgerCommand)
  // Spelled out, not TOOL.*: `claude plugin validate` reads a matcher only from its literal.
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_close' }, onLedgerTool)
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_drop' }, onLedgerTool)
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_add' }, onLedgerTool)
}

// ── GUARDS ──────────────────────────────────────────────────────────────────
//
// The fleet's refusals, in front of the tool, from inside the session.
//
// Until the mod, each of these was a shell hook or a check inside a command, and each could
// only fail OPEN: a PreToolUse hook that cannot find jq exits 0 and the call goes on, which
// is right for a hook that must never break a session and wrong for one whose whole job is
// to say no. Here every guard is a `tool.call` hook registered with a `.catch` that refuses:
// a hook that throws, answers a wrong shape, or outlasts its budget DENIES the call. An
// observer (register.js) fails open; a guard fails closed.
//
//   JARVIS          the confirm-list (docs/jarvis.md): merge/push, stop/reclaim/force,
//                   worktree and project removal, answering a worker's prompt, a second
//                   worker per request. Bash and the ghostfleet MCP tools.
//   MERGE           a worker does not merge its own PR, nor change its own boundaries
//                   ("workers can merge", hooks/fleet-guard.sh). Bash and merge_pull_request.
//   APPROVE         an agent does not approve another agent's tool call ("agents can approve
//                   tool calls", bin/fleet-answer). fleet-answer in Bash and fleet_answer.
//
// ONE RULE, ASKED FROM HERE. Jarvis's proposals live behind a lock three processes share,
// and fleet-answer reads a pane to decide; neither is something to write twice. So those two
// ask the code that already decides (lib/mod-gate.mjs, `fleet-answer --check`) as a process,
// and refuse on anything that is not a clear answer. The merge guard's rule is small enough
// to hold here (./guard-shape.js, plain functions the suite runs with node) and its facts come from git, tmux, the fleet dir and gh.
//
// THE SHELL VERSIONS STAY, for every session without the mod: another agent, an older
// Claude, an organization that blocks mods. Where both run, they agree: the shell guard
// refuses what this refuses, and Jarvis's gate leaves a single-use relay so the door behind
// this one passes the call the owner said yes to instead of spending his yes a second time.
//
// THE COST, for the call that is none of these. Every Bash call in every session comes
// through the Bash hook, so it decides from the command text first: no process, no file,
// unless the text could be a merge, a boundary write or a fleet-answer, or the session is
// Jarvis's master (one small file read).

const GUARD_MS = 15_000

// A process call that rejects rather than settling to a fallback: a guard that could not
// learn a fact refuses, and the throw is how it gets to the `.catch` that does. The bound is
// the call's own timeout (it rejects), not a $.clock.sleep race: time inside $.process.run
// is not the hook's, while a sleep's is, and a hook that outruns its 10s is skipped.
async function guardRun($, argv, init = {}) {
  const out = await $.process.run(argv, { ...init, timeoutMs: init.timeoutMs || GUARD_MS })
  return { code: out.exitCode, out: String(out.stdout || ''), err: String(out.stderr || '') }
}

const bin = ($, name) => `${$.plugin.root}/../../bin/${name}`
const lib = ($, name) => `${$.plugin.root}/../../lib/${name}`

// ── JARVIS ──────────────────────────────────────────────────────────────────

async function jarvisDir($) {
  return (await $.env.get('CLAUDE_FLEET_JARVIS_DIR')) || `${await $.env.get('HOME')}/.config/ghostfleet`
}

// Is this session Jarvis's master? Cheaply, from the marker and the session's own
// identity; lib/mod-gate.mjs asks again from the live $TMUX, exactly as the MCP door does,
// so this only decides whether to ask at all. No marker is no Jarvis, as in the shell guard.
// `command`, for a Bash call: also whether the confirm-list could act on it at all.
async function maybeJarvis($, command) {
  const dir = await jarvisDir($)
  const file = `${dir}/jarvis`
  if (!(await $.fs.exists(file))) return false
  // Switched off (lib/jarvis.mjs enabled) is no Jarvis: nothing to ask the gate, which would
  // otherwise refuse — it fails closed — on behalf of a Jarvis that is not there.
  if (await $.fs.exists(`${file}.enabled`) && /^\s*off\s*$/.test(await $.fs.read(`${file}.enabled`))) return false
  const sock = markerSock(await $.fs.read(file))
  if (!sock) return false
  if (command !== undefined && !jarvisMightAct(command, sock, dir)) return false
  const who = await identity($, await ownRecord($))
  return who.sock === sock && (!who.slot || who.slot === 'master')
}

// 0 = go, 2 = refused; anything else is no answer, which throws.
async function askGate($, argv, stdin) {
  const r = await guardRun($, ['node', lib($, 'mod-gate.mjs'), ...argv], { stdin })
  if (r.code === 0) return { ok: true, granted: /\bgranted\b/.test(r.out) }
  if (r.code === 2) return { ok: false, text: r.err.trim() }
  throw new Error(`lib/mod-gate.mjs ${argv[0]} exited ${r.code}: ${r.err.trim().slice(0, 300)}`)
}

// ── MERGE ───────────────────────────────────────────────────────────────────

// git -C dir rev-parse …: the value, or null when dir is not in a repository at all. Any
// other failure (git missing, a timeout, a broken repo) throws.
async function gitIn($, dir, args) {
  const r = await guardRun($, ['git', '-C', dir, ...args])
  if (r.code === 0) return r.out.trim()
  if (/not a git repository|cannot change to|No such file/i.test(r.err)) return null
  throw new Error(`git ${args.join(' ')} in ${dir}: ${r.err.trim().slice(0, 200)}`)
}

async function isLinked($, dir) {
  if (!dir) return false
  const gd = await gitIn($, dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
  if (gd === null) return false
  const gcd = await gitIn($, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return Boolean(gd && gcd && gd !== gcd)
}

// The registered project a checkout belongs to, as hooks/fleet-guard.sh registered_project
// finds it: ~/.config/ghostfleet/projects and projects.<profile>, physical paths both sides.
async function registeredProject($, gitroot) {
  const dir = `${await $.env.get('HOME')}/.config/ghostfleet`
  if (!(await $.fs.exists(dir))) return ''
  const files = (await $.fs.list(dir)).map(f => f.name).filter(n => n === 'projects' || /^projects\.[A-Za-z0-9_-]+$/.test(n))
  const home = await $.env.get('HOME')
  for (const f of files) {
    for (const line of (await $.fs.read(`${dir}/${f}`)).split('\n')) {
      if (/^\s*#/.test(line)) continue
      const [name, raw] = line.split('\t')
      if (!name || !raw) continue
      let root = raw.replace(/^~/, home).replace(/\/$/, '')
      const phys = await guardRun($, ['/bin/sh', '-c', 'cd "$1" 2>/dev/null && pwd -P', 'sh', root])
      if (phys.code === 0 && phys.out.trim()) root = phys.out.trim()
      if (gitroot === root || gitroot.startsWith(`${root}/`)) return name
    }
  }
  return ''
}

// The sessions whose <sock>.<child>.parent marker names `me`, and their branches.
async function childBranches($, dir, sock, me) {
  const kids = []
  for (const f of await $.fs.list(dir)) {
    if (!f.name.startsWith(`${sock}.`) || !f.name.endsWith('.parent')) continue
    const parent = (await $.fs.read(`${dir}/${f.name}`)).split('\n')[0].trim()
    if (parent === me) kids.push(f.name.slice(sock.length + 1, -'.parent'.length))
  }
  let manifest = ''
  try { manifest = await $.fs.read(`${dir}/${sock}.manifest.tsv`) } catch {}
  const branches = []
  for (const k of kids) {
    let b = ''
    for (const line of manifest.split('\n')) {
      const c = line.split('\t')
      if (c[1] === k && c[2]) { b = c[2]; break }
    }
    if (!b) {
      const p = await guardRun($, ['tmux', '-L', sock, 'display-message', '-p', '-t', k, '#{pane_current_path}'])
      if (p.code === 0 && p.out.trim()) b = (await gitIn($, p.out.trim(), ['rev-parse', '--abbrev-ref', 'HEAD'])) || ''
    }
    if (b) branches.push(b)
  }
  return branches
}

// null = not this guard's business; otherwise { deny } or { ok }.
async function mergeGuard($, e) {
  const bash = e.tool === 'Bash'
  const kind = !bash ? 'merge' : mergesAPr(e.command) ? 'merge' : changesABoundary(e.command) ? 'setting' : ''
  if (!kind) return null
  const cwd = await $.session.cwd()
  const root = await $.session.root()
  const gitroot = await gitIn($, cwd, ['rev-parse', '--show-toplevel'])
  if (gitroot === null) return null                    // not a repo: nothing here to protect
  // Is there a fleet here at all? Inside one, or beside a registered project's live one.
  const who = await identity($, await ownRecord($))
  let sock = who.sock
  if (!sock) {
    const proj = await registeredProject($, gitroot)
    if (!proj) return null
    if ((await guardRun($, ['tmux', '-L', `cf-${proj}`, 'list-sessions'])).code !== 0) return null
    sock = `cf-${proj}`
  }
  // From the directory it was started in as well as the one it is in now, so a `cd` into
  // the main checkout is not a way round it. The main checkout is the lead's: it merges.
  const where = (await isLinked($, cwd)) ? cwd : (await isLinked($, root)) ? root : ''
  if (!where) return null
  if (kind === 'setting') return { deny: SETTING_REFUSAL }
  const branch = (await gitIn($, where, ['rev-parse', '--abbrev-ref', 'HEAD'])) || ''
  const dir = await fleetDir($)
  const pane = await $.env.get('TMUX_PANE')
  let sess = ''
  if (pane) {
    const r = await guardRun($, ['tmux', '-L', sock, 'display-message', '-p', '-t', pane, '#{session_name}'])
    if (r.code === 0) sess = r.out.trim()
  }
  sess = sess || who.slot || (await $.env.get('CLAUDE_FLEET_SLOT')) || ''
  const markers = new Set((await $.fs.list(dir)).map(f => f.name))
  if (boundaryOn('workers-merge', sock, sess, n => markers.has(n))) return { ok: true }
  // A SUB-LEAD MERGES ITS CHILDREN'S PRs INTO ITS OWN BRANCH (hooks/fleet-guard.sh says
  // why): base = this session's branch AND head = one of its children's branches. Asked of
  // GitHub; any failure to learn them refuses.
  if (sess && branch && !markers.has(`${sock}.${sess}.parent`) && !markers.has(`${sock}.${sess}.workers-merge-off`)) {
    const kids = await childBranches($, dir, sock, sess)
    if (kids.length) {
      const { sel, repo } = bash ? prSelector(e.command) : { sel: String(e.pullNumber ?? e.pull_number ?? ''), repo: '' }
      const r = await guardRun($, ['gh', 'pr', 'view', ...(sel ? [sel] : []), ...(repo ? ['-R', repo] : []),
        '--json', 'baseRefName,headRefName', '-q', '.baseRefName + "\\t" + .headRefName'], { cwd: where })
      const [base, head] = r.out.trim().split('\t')
      if (r.code === 0 && base === branch && head && kids.includes(head)) return { ok: true }
    }
  }
  return { deny: mergeRefusal(where, branch, sock, sess) }
}

// ── APPROVE ─────────────────────────────────────────────────────────────────

// fleet-answer's own decision for each fleet-answer the command runs. A command whose
// words cannot be known from here (answerCalls null) is left to fleet-answer itself, which
// still decides when the command runs: that is today's behaviour, not a gap this opens.
async function answerGuardBash($, e) {
  if (!/fleet-answer/.test(e.command)) return null
  const calls = answerCalls(e.command)
  if (!calls || !calls.length) return null
  for (const argv of calls) {
    const r = await guardRun($, [bin($, 'fleet-answer'), '--check', ...argv], { cwd: await $.session.cwd() })
    if (r.code === 0 || r.code === 1) continue
    if (r.code === 3 || r.code === 4) return { deny: r.err.trim() }
    throw new Error(`fleet-answer --check exited ${r.code}: ${r.err.trim().slice(0, 300)}`)
  }
  return null
}

// ── the hooks ───────────────────────────────────────────────────────────────

async function onBash($, e, next) {
  // Jarvis first, as its hook is the first door today: a refused proposal ends it there.
  if (await maybeJarvis($, e.command)) {
    const g = await askGate($, ['jarvis-bash'], e.command)
    if (!g.ok) return { deny: g.text }
  }
  const merge = await mergeGuard($, e)
  if (merge && merge.deny) return { deny: merge.deny }
  const answer = await answerGuardBash($, e)
  if (answer && answer.deny) return { deny: answer.deny }
  return next(e)
}

async function onMcp($, e, next) {
  if (isMergeTool(e.tool)) {
    const merge = await mergeGuard($, e)
    if (merge && merge.deny) return { deny: merge.deny }
    return next(e)
  }
  const name = fleetTool(e.tool)
  if (!JARVIS_TOOLS.has(name)) return next(e)
  const a = callArgs(e)
  let granted = false
  if (await maybeJarvis($)) {
    const g = await askGate($, ['jarvis-mcp', name], JSON.stringify(a))
    if (!g.ok) return { deny: g.text }
    granted = g.granted
  }
  // The owner's yes to a fleet_answer IS the human approval: the MCP door adds
  // --human-approved for exactly that call, so asking fleet-answer without it would refuse
  // what he just said yes to.
  if (name === 'fleet_answer' && !granted) {
    const g = await askGate($, ['answer-mcp'], JSON.stringify(a))
    if (!g.ok) return { deny: g.text }
  }
  return next(e)
}

// A guard that throws refuses. Where it had already called `next`, the call it judged has
// run, and replaying that answer is the only honest thing left (the engine runs nothing
// twice); every guard here judges before it calls `next`. A re-entry (the call raised
// beneath one of this hook's own `$` calls) was judged by nobody, and is refused too.
function whyFailed(next) {
  const err = next.error || {}
  return err.message || (err.kind === 're-entry' ? 'it was raised beneath the guard\'s own call' : err.kind) || 'the guard failed'
}
function bashFailedClosed($, e, next) {
  return next.called ? next(e) : { deny: failedClosed('this command', whyFailed(next)) }
}
function mcpFailedClosed($, e, next) {
  return next.called ? next(e) : { deny: failedClosed('this call', whyFailed(next)) }
}

// ── BAND ────────────────────────────────────────────────────────────────────
//
// A lead's team at a glance, above its prompt, without a turn.
//
// A lead asks "who needs me" by running fleet-inbox, or now /fleet: a question it has to
// think to ask, in a session whose attention is on whatever it was doing. The band says it
// without being asked, in one line above the prompt:
//
//     3 workers · 1 working · 1 need you · 2 PRs green
//
// Only for a LEAD: the session named `master` on its fleet socket, or a worker with children
// (a sub-lead: some <sock>.<child>.parent names it). A worker without children draws nothing,
// and a worker becomes a sub-lead's band the tick after its first child appears.
//
// CHEAP BY CONSTRUCTION. Nothing here starts a turn or calls a model. Every TICK_MS the
// session lists its fleet dir (one directory read, which is all a non-lead ever does) and, a
// lead only, asks tmux which sessions are alive and reads the records it has not read at
// that mtime. PRs are GitHub's to say, so a lead asks `gh` every PR_MS, bounded, and says
// `PRs ?` when it cannot. The band redraws only when what it says changes ($.state).
//
// An observer, like STATE above: a tick that fails leaves the band as it was,
// and a draw that fails is skipped and the engine draws its own (nothing, for this band).

const BAND_TICK_MS = 5_000
const BAND_PR_MS = 120_000
const GH_MS = 15_000

// The one value the band draws, declared in ../types/index.d.ts.
const BAND = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'band' })

let bandTick = null
let prTick = null
let lead = null          // { sock, me, team } while this session is a lead
let prs                  // undefined: not read yet; null: could not; else the summary
const seen = new Map()   // record file -> { mtimeMs, rec }

const soon = ($, work, fallback, ms = IO_MS) => bounded($, work, ms, fallback)

async function aliveSessions($, sock) {
  const out = await soon($, $.process.run(['tmux', '-L', sock, 'list-sessions', '-F', '#{session_name}'], { timeoutMs: IO_MS }), null)
  if (!out || out.exitCode !== 0) return null
  return String(out.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
}

async function readTeamRecords($, dir, entries) {
  const recs = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name.startsWith('.')) continue
    const file = `${dir}/${f.name}`
    const had = seen.get(file)
    if (had && had.mtimeMs === f.mtimeMs) { recs.push(had.rec); continue }
    let rec = null
    try { rec = JSON.parse(await $.fs.read(file)) } catch {}
    seen.set(file, { mtimeMs: f.mtimeMs, rec })
    recs.push(rec)
  }
  for (const k of seen.keys()) if (!entries.some(f => `${dir}/${f.name}` === k)) seen.delete(k)
  return recs
}

async function childrenOf($, dir, entries, sock, me) {
  const kids = []
  for (const f of entries) {
    if (!f.name.startsWith(`${sock}.`) || !f.name.endsWith('.parent')) continue
    const parent = await soon($, $.fs.read(`${dir}/${f.name}`), '')
    if (String(parent).split('\n')[0].trim() === me) kids.push(f.name.slice(sock.length + 1, -'.parent'.length))
  }
  return kids
}

async function publish($, value) {
  const cur = await soon($, $.state.get(BAND), null)
  if (JSON.stringify(cur && cur.value) === JSON.stringify(value)) return
  await soon($, $.state.set(BAND, value), null)
}

async function refresh($) {
  const who = await identity($, await ownRecord($))
  if (!who.sock || !who.slot) { lead = null; return publish($, null) }
  const dir = await fleetDir($)
  const entries = await soon($, $.fs.list(dir), null)
  if (!entries) return
  const kids = who.slot === 'master' ? [] : await childrenOf($, dir, entries, who.sock, who.slot)
  if (who.slot !== 'master' && !kids.length) { lead = null; return publish($, null) }
  const alive = await aliveSessions($, who.sock)
  if (!alive) return
  const team = teamOf(who.slot, alive, kids)
  if (!team) { lead = null; return publish($, null) }
  const wasLead = lead !== null
  lead = { sock: who.sock, me: who.slot, team, dir }
  if (!wasLead) refreshPrs($).catch(() => {})
  const bySlot = latestBySlot(await readTeamRecords($, dir, entries), who.sock)
  const s = summarize(team, bySlot, await $.clock.now())
  await publish($, { ...s, prs })
}

async function refreshPrs($) {
  if (!lead) return
  const { me, dir, sock } = lead
  const cwd = await $.session.cwd()
  const out = await soon($, $.process.run(['gh', 'pr', 'list', '--state', 'open', '--limit', '100',
    '--json', 'number,headRefName,baseRefName,statusCheckRollup'], { cwd, timeoutMs: GH_MS }), null, GH_MS + 1000)
  let list = null
  try { if (out && out.exitCode === 0) list = JSON.parse(String(out.stdout || '[]')) } catch {}
  if (!Array.isArray(list)) { prs = null; return refresh($) }
  let branch = ''
  if (me !== 'master') {
    const b = await soon($, $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: IO_MS }), null)
    branch = b && b.exitCode === 0 ? String(b.stdout).trim() : ''
  }
  const manifest = String(await soon($, $.fs.read(`${dir}/${sock}.manifest.tsv`), ''))
  const fleetBranches = manifest.split('\n').map(l => l.split('\t')[2]).filter(Boolean)
  prs = prSummary(list, { me, branch, fleetBranches })
  return refresh($)
}

// The team's row, then the ledger's (LEDGER, below), each only when it has something to say.
async function onBandRender($, e, next) {
  if (e.props.hasSurvey) return next(e)
  const { value } = await $.state.get(BAND)
  const team = value ? bandRuns(value, value.prs, e.props.bodyColumns) : null
  const led = (await $.state.get(LEDGER)).value
  const book = led ? ledgerRuns(led, led.asOf, e.props.bodyColumns) : null
  if (!team && !book) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  const row = (runs, k) => h(Box, { key: k, flexDirection: 'row' },
    ...runs.map((r, i) => h(Text, {
      key: String(i), wrap: 'truncate-end',
      ...(r.color ? { color: r.color } : {}), ...(r.dim ? { dimColor: true } : {}), ...(r.bold ? { bold: true } : {}),
    }, r.text)))
  return h(Box, { flexDirection: 'column' }, ...(team ? [row(team, 'team')] : []), ...(book ? [row(book, 'ledger')] : []))
}

// Started from onSessionStart (one session.start hook per module), after the record exists.
function startBand($) {
  if (bandTick) bandTick.cancel()
  if (prTick) prTick.cancel()
  refresh($).catch(() => {})
  bandTick = $.clock.every(BAND_TICK_MS, () => { refresh($).catch(() => {}); ledgerRefresh($).catch(() => {}) })
  prTick = $.clock.every(BAND_PR_MS, () => { refreshPrs($).catch(() => {}) })
}

// ── LEDGER ──────────────────────────────────────────────────────────────────
//
// Every request made of this session, held open until a final message answers it.
//
// A person types three messages while a turn runs; the prompt tells the model to treat each
// as queued work and never to end a turn with one neither done nor reported not-done. That
// instruction is dropped often enough to matter, and nothing outside the model could see it
// happen: the second message's answer is simply never written, and the person finds out
// when they go looking. So does "I'll merge when it's green", said once and never done.
// From in here both are visible: `prompt.submit` sees every message the moment Enter is
// pressed (with the turn it was typed over), `turn.step` sees the text of every step of a
// turn, and `turn.complete` sees how it ended.
//
//   RECORD   each request an item in <fleet dir>/<session_id>.ledger (./ledger.js has the
//            shape), its open count in the status record (`ledger`), the oldest on the band
//   JUDGE    at a main-loop turn.complete that ended with an answer, a small-model call per
//            ten open items (when something is open, or the answer sounds like a promise):
//            which open items the turn's text, all of it, addressed, and what its final text
//            promised. A promise kept open through five judged turns closes as stale
//   GATE     items still open after that get ONE re-prompt, ever, naming them
//
// A NAG, NOT A GUARD. It fails OPEN everywhere: a judge that errors, times out or answers
// a wrong shape closes nothing and re-prompts nothing (the item stays open, the failure is
// noted in the file and the debug log). It never gates a turn the person interrupted, a
// subagent's run, a headless (-p) session, or after a queued message has already started
// the next turn (that turn's own end is judged instead). The loop bound is in the data,
// not in a counter that a reload would reset: an item carries `gated` once it has been
// re-prompted, and a gated item is never re-prompted again.
//
// Not retroactive: only messages submitted after the mod loaded. The judge runs after
// turn.complete has resolved, never inside it, so the turn's end never waits on a model.

const LEDGER = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'ledger' })
const JUDGE_MS = 30_000

let ledgerCfg = null
let ledgerQueue = Promise.resolve()
let currentTurn = ''
let judging = false
let judgeNext = null     // a turn.complete that arrived while the judge was busy
let turnsStarted = 0     // main-loop turn.starts, so a verdict can tell it went stale
let answers = []         // the last few judged turns: { at, turnId, blocks }
let stepTexts = new Map() // turnId -> the text each of its main-loop steps wrote, in order
let ledgerShown = ''     // what the band and the record last said
let ledgerAsOf = 0

async function ledgerConfigOf($) {
  if (ledgerCfg) return ledgerCfg
  // Each name spelled out: the engine lists what a module reads from its literal names.
  const env = {
    CLAUDE_FLEET_LEDGER: await bounded($, $.env.get('CLAUDE_FLEET_LEDGER'), IO_MS, undefined),
    CLAUDE_FLEET_LEDGER_GATE: await bounded($, $.env.get('CLAUDE_FLEET_LEDGER_GATE'), IO_MS, undefined),
    CLAUDE_FLEET_LEDGER_PROMISES: await bounded($, $.env.get('CLAUDE_FLEET_LEDGER_PROMISES'), IO_MS, undefined),
    CLAUDE_FLEET_LEDGER_MODEL: await bounded($, $.env.get('CLAUDE_FLEET_LEDGER_MODEL'), IO_MS, undefined),
  }
  ledgerCfg = ledgerConfig(k => env[k])
  return ledgerCfg
}

async function ledgerPath($) {
  const sid = await $.session.id()
  return sid ? ledgerFile(await fleetDir($), sid) : ''
}

// A missing file is an empty ledger; one that could not be read (a stall, a permission) is
// null, and a change against null is skipped: written over, it would wipe the history.
const UNREAD = Symbol('unread')
async function readLedger($, file) {
  const text = await bounded($, (async () => ((await $.fs.exists(file)) ? $.fs.read(file) : ''))(), IO_MS, UNREAD)
  return text === UNREAD ? null : parseLedger(text)
}

// One change at a time, read-modify-write against the FILE, never a copy held here:
// fleet-ledger closes items from outside, and a copy would undo it on the next write.
function changeLedger($, change) {
  const run = ledgerQueue.then(() => bounded($, applyLedger($, change), IO_MS * 3, null))
  ledgerQueue = run.then(() => undefined, () => undefined)
  return run
}

async function applyLedger($, change) {
  const file = await ledgerPath($)
  if (!file) return null
  const cur = await readLedger($, file)
  if (!cur) return null
  const next = change(cur)
  if (!next) return null
  const dir = file.slice(0, file.lastIndexOf('/'))
  const tmp = `${dir}/.${file.slice(dir.length + 1)}.tmp`
  await $.fs.write(tmp, JSON.stringify(next))
  const moved = await $.process.run(['mv', '-f', tmp, file], { timeoutMs: IO_MS })
  if (moved.exitCode !== 0) return null
  await showLedger($, next)
  return next
}

// The band's row and the record's count, rewritten only when what they say changed. The
// band's "oldest 4m" is drawn against `asOf`, a minute bucket, so the age moves once a
// minute rather than redrawing every tick.
async function showLedger($, ledger) {
  const nowMs = await $.clock.now()
  const s = ledgerSummary(ledger, nowMs)
  const asOf = Math.floor(nowMs / 60_000) * 60_000
  const said = JSON.stringify(s)
  if (said === ledgerShown && asOf === ledgerAsOf) return
  const recChanged = said !== ledgerShown
  ledgerShown = said
  ledgerAsOf = asOf
  await bounded($, $.state.set(LEDGER, (s.open || s.promises || s.judgeFailing) ? { ...s, asOf } : null), IO_MS, null)
  if (recChanged) {
    const field = {
      open: s.open, promises: s.promises, ...(s.oldest ? { oldest_at: Math.floor(s.oldest.at / 1000) } : {}),
      ...(s.judgeFailing ? { judge_failing: s.judgeFailing } : {}),
    }
    await patchRecord($, rec => ({ ...rec, ledger: field }))
  }
}

async function ledgerStart($) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  await bounded($, Promise.all([
    $.command.register({
      name: 'ledger', description: "This session's open requests and promises; close <id>, clear (no turn)", immediate: true,
    }),
    // Not deferred: a tool the agent has to go looking for is a tool it forgets to call, and
    // the three schemas together are a few hundred characters.
    $.tool.register({
      name: 'ledger_close', isDeferred: false,
      description: "Close one of this session's ledger items (the open requests and promises the prompt's ledger note lists) once it is finished. The proof is required: a path, link, commit, PR number or command result that shows it is done.",
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The item id, as the ledger note gives it' }, proof: { type: 'string', description: 'What shows it is done: a path, link, commit, PR number or command result' } }, required: ['id', 'proof'] },
    }),
    $.tool.register({
      name: 'ledger_drop', isDeferred: false,
      description: 'Drop a ledger item that is not a real ask, or that the person cancelled. The reason is required.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    }),
    $.tool.register({
      name: 'ledger_add', isDeferred: false,
      description: "Track an ask from the person's latest message that the ledger note did not list.",
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The ask, in the person\'s words' } }, required: ['text'] },
    }),
  ]), IO_MS, null)
  ledgerShown = ''
  ledgerAsOf = 0
  await ledgerRefresh($)
}

// The band tick rereads the file, so a close made from outside shows within a tick.
async function ledgerRefresh($) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  const file = await ledgerPath($)
  const l = file ? await readLedger($, file) : null
  if (l) await showLedger($, l)
}

// Recorded BEFORE `next`, so the note the prompt carries can name its own items by id; the
// turn they belong to is stamped after, once `next` has started it. A slash command is the
// harness's, and carries nothing.
async function onPromptSubmit($, e, next) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on || String(e.text || '').trimStart().startsWith('/')) return next(e)
  const before = currentTurn
  const at = await $.clock.now()
  const source = sourceOf(e)
  const ids = []
  let window = 0
  let cur = source ? await changeLedger($, l => {
    window = Number(l.window) || 0
    return addPrompt(l, { text: e.text, at, turnId: e.turnId || '', source, queued: Boolean(e.turnId) }, ids)
  }) : null
  if (!cur) {
    const file = await ledgerPath($)
    cur = file ? await readLedger($, file) : null
  }
  const note = cur ? contextNote(cur, at) : ''
  const r = await next(note ? { ...e, context: [...(e.context || []), note] } : e)
  if (!ids.length) return r
  if (!r || r.drop !== undefined) {
    // It never entered: its items go, and the window goes back to the one before.
    await changeLedger($, l => ({ ...dropItems(l, ids), window }))
    return r
  }
  // Typed over a running turn, it carries that turn's id. Submitted idle, `next` resolves
  // once its own turn started: a turn.start since is that turn; failing that, the turn's
  // start names it (ledgerTurnStart), whichever of the two lands second.
  const turnId = e.turnId || (currentTurn !== before ? currentTurn : '')
  if (turnId && !e.turnId) await stampItems($, ids, turnId)
  return r
}

async function stampItems($, ids, turnId) {
  if (!ids.length || !turnId) return
  await changeLedger($, l => (l.items.some(i => ids.includes(i.id) && !i.turnId)
    ? { ...l, items: l.items.map(i => (ids.includes(i.id) && !i.turnId ? { ...i, turnId } : i)) } : null))
}

// ledger_close, ledger_drop and ledger_add: the agent's own hand on its items (./ledger.js).
async function onLedgerTool($, e) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return { result: 'ledger: off (CLAUDE_FLEET_LEDGER=off)' }
  const a = callArgs(e)
  const ctx = { nowMs: await $.clock.now(), turnId: currentTurn }
  const act = e.tool === TOOL.close ? l => closeByAgent(l, a.id, a.proof, ctx)
    : e.tool === TOOL.drop ? l => dropByAgent(l, a.id, a.reason, ctx)
      : l => addByAgent(l, a.text, ctx)
  let said = 'ledger: the file could not be read just now; nothing changed'
  await changeLedger($, l => { const r = act(l); said = r.said; return r.ledger })
  return { result: said }
}

async function ledgerTurnStart($, e) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on || !e.text) return
  await changeLedger($, l => stampTurn(l, e.text, e.turnId))
}

// A prompt fleet-send handed over, as DELIVERY claims it: one item (a brief is not split into
// its sentences) in a window of its own, unless it is a nudge. Its turn.start stamps the item
// with the turn and arms the note (ledgerNoteOnTool).
async function ledgerDelivery($, p) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  const at = await $.clock.now()
  const ids = []
  if (!p.nudge) await changeLedger($, l => addPrompt(l, { text: p.text, at, source: 'fleet', whole: true }, ids))
  p.ledgered = ids
}

async function ledgerUndo($, ids) {
  await changeLedger($, l => dropItems(l, ids))
}

// A plugin's submit cannot carry context either (PromptSubmitArgs leaves it out), so the note
// a delivered prompt should have had rides on the first tool result of the turn it started,
// read as a PostToolUse reminder is: a worker handed a brief nearly always calls a tool before
// it calls ledger_close, and without the note it could not name the brief's item at all.
let noteDue = ''          // the turn whose first tool result carries the ledger note
async function ledgerNoteOnTool($, done) {
  if (!noteDue || noteDue !== currentTurn || !done || done.deny !== undefined || done.isError) return done
  noteDue = ''
  const file = await ledgerPath($)
  const cur = file ? await readLedger($, file) : null
  const note = cur ? contextNote(cur, await $.clock.now()) : ''
  return note ? { ...done, context: [...(done.context || []), note] } : done
}

// Recorded at the turn it started, for a prompt DELIVERY claimed before this process did.
async function ledgerFleetItem($, text, turnId) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  const at = await $.clock.now()
  await changeLedger($, l => addPrompt(l, { text, at, turnId, source: 'fleet', whole: true }))
}

// Kept for the last few turns only: a turn that never completes (a crash, a reload) must
// not hold its texts for the life of the session.
function noteStep(turnId, text) {
  const list = stepTexts.get(turnId) || []
  stepTexts.delete(turnId)
  stepTexts.set(turnId, [...list, text])
  while (stepTexts.size > 4) stepTexts.delete(stepTexts.keys().next().value)
}

function takeSteps(e) {
  const steps = stepTexts.get(e.turnId) || []
  stepTexts.delete(e.turnId)
  return turnBlocks(steps, e.answer)
}

// One judge at a time. A turn.complete that arrives while one runs is not dropped: the
// newest waits and is judged next (measured: two queued messages ran as a 1-second turn
// while the first turn's judge was still out, and that turn's answer was never judged).
async function ledgerTurnComplete($, e, blocks = turnBlocks([], e.answer), generation = turnsStarted) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  if (e.reason === 'aborted') await changeLedger($, l => markInterrupted(l, e.turnId))
  if (e.reason !== 'answer') return
  const at = await $.clock.now()
  answers = [...answers, { at, turnId: e.turnId, blocks }].slice(-3)
  if (judging) { judgeNext = { e, blocks, generation }; return }
  judging = true
  try {
    await judgeTurn($, cfg, e, blocks, at, generation)
  } catch (err) {
    void $.ui.log(`ghostfleet ledger: judge threw (${String(err && err.message || err)}); failing open`, { to: 'debug' })
  } finally {
    judging = false
  }
  const queued = judgeNext
  judgeNext = null
  if (queued) {
    answers = answers.filter(a => a.turnId !== queued.e.turnId)
    await ledgerTurnComplete($, queued.e, queued.blocks, queued.generation)
  }
}

// `blocks`: every text block the turn wrote. `generation`: how many turns had started when
// this one ended.
async function judgeTurn($, cfg, e, blocks, nowMs, generation) {
  const surfaces = await bounded($, $.session.surfaces(), IO_MS, null)
  if (!surfaces || !surfaces.length) return                  // -p, the SDK: nobody to nag
  const file = await ledgerPath($)
  if (!file) return
  const cur = await readLedger($, file)
  if (!cur) return
  // The judge is the backup: it reads only what is still open after the agent's own closes
  // (ledger_close, ledger_drop), and a turn whose agent closed everything costs no call at
  // all, not even the promise read: an agent that closes its items with proof is the one
  // the hybrid is for, and a call per turn to second-guess it is the cost it removes.
  const open = openItems(cur, nowMs)
  const closedOwn = cur.items.some(i => i.closedBy === 'agent' && i.closedTurn === e.turnId)
  const promises = cfg.promises !== 'off' && soundsLikeAPromise(e.answer)
  if (!open.length && (closedOwn || !promises)) return       // nothing to judge: no call
  // The turns since the oldest open item was made, this one last: a request answered one
  // turn ago and only referred to now ("I ended my previous reply with it") is still
  // answered.
  const since = open.length ? Math.min(...open.map(i => i.at)) : nowMs
  const earlier = answers.slice(0, -1).filter(a => a.at >= since).map(a => a.blocks)
  // In batches, newest first (ledger.js JUDGE_BATCH): one call for every open item ran out of
  // reply past ~20 items, and from then on every turn's judge failed. Promises are read once,
  // by the first call; the others are told to return none. The calls run one after another:
  // the newest batch is the one most likely to matter, and it lands first.
  const batches = open.length ? judgeBatches(open) : [[]]
  // The first call reads the turn's promises, so it is shown every open one to name the one a
  // phrase restates, whichever batch that promise is judged in.
  const openPromises = judgeBatches(open.filter(i => i.source === 'promise'))[0] || []
  let after = null
  const failed = []
  let answered = 0
  for (const [k, batch] of batches.entries()) {
    const r = await $.model.complete({
      model: cfg.model, prompt: judgePrompt(batch, blocks, { ...cfg, promises: k ? 'off' : cfg.promises, earlier, openPromises }),
      maxTokens: JUDGE_TOKENS, effort: 'low', timeoutMs: JUDGE_MS,
    })
    const verdict = r && r.isAnswered ? parseVerdict(r.text, batch.map(i => i.id)) : null
    if (!verdict) {
      failed.push(!r ? 'no result' : !r.isAnswered ? `${r.reason}${r.error ? ` ${r.error}` : ''}` : 'reply was not the JSON asked for')
      continue
    }
    // What a cut-off reply finished still applies; the items it never reached stay open.
    if (verdict.partial) failed.push(`reply cut off after ${verdict.items.length} of ${batch.length} items`)
    answered += verdict.items.length
    after = await changeLedger($, l => applyVerdict(l, verdict, { nowMs, turnId: e.turnId, promises: k ? 'off' : cfg.promises })) || after
  }
  const judge = failed.length
    ? { at: nowMs, ok: false, why: failed[0], items: answered, calls: batches.length, failedCalls: failed.length }
    : { at: nowMs, ok: true, items: answered, calls: batches.length }
  const kept = await changeLedger($, l => ({ ...l, judge }))
  if (failed.length) {
    void $.ui.log(`ghostfleet ledger: judge failed open on ${failed.length} of ${batches.length} call(s) (${failed[0]}); ${open.length - answered} item(s) unjudged`, { to: 'debug' })
    // A batch that failed closes nothing and re-prompts nothing: no gate on this turn.
    return
  }
  after = kept || after
  if (!after || !cfg.gate) return
  // A turn started since this one ended (a queued message, typed or handed over): the
  // verdict is about work that has moved on, and that turn's own end is judged next. Asked
  // by count, not by "is a turn running now": the measured case was a turn that started
  // AND finished while the judge was out, which an is-it-running check reads as idle.
  if (turnsStarted !== generation || turnRunning || pending || judgeNext) return
  const judged = new Set(open.map(i => i.id))
  let targets = gateTargets(after, nowMs, cfg).filter(i => judged.has(i.id))
  if (!targets.length) return
  // Asked of every open queued or interrupted item, not only the targets: the rewound copy of
  // a message stopped and sent again is from the window before, so the gate would never name
  // it, and unasked it stayed open beside its resend as a second item for one message.
  const unsure = [...targets, ...openItems(after, nowMs).filter(i => (i.queued || i.interrupted) && !targets.includes(i))]
    .filter(i => i.queued || i.interrupted)
  if (unsure.length) {
    const msgs = await bounded($, $.session.messages(), IO_MS, null)
    // Cannot tell what the model received: fail open, no nag about a queued or interrupted message.
    const gone = msgs
      ? withdrawn(unsure, msgs.filter(m => m.role === 'user').map(m => m.text), after.items)
      : unsure.map(i => i.id)
    if (msgs && gone.length) await changeLedger($, l => dropItems(l, gone))
    targets = targets.filter(i => !gone.includes(i.id))
    if (!targets.length) return
  }
  const ids = targets.map(i => i.id)
  // Marked BEFORE the submit: a crash between the two loses one nag, never adds a second.
  const marked = await changeLedger($, l => markGated(l, ids, nowMs))
  if (!marked) return
  // Framed ("the ghostfleet plugin sent a message"), not asUser: it is the mod talking.
  void Promise.resolve($.prompt.submit({ text: gatePrompt(targets) })).catch(() => {})
}

async function onLedgerCommand($, e) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return { text: 'ledger: off (CLAUDE_FLEET_LEDGER=off)' }
  const file = await ledgerPath($)
  if (!file) return { text: 'ledger: this session has no id yet' }
  const [verb = 'list', arg] = String(e.args || '').trim().split(/\s+/).filter(Boolean)
  const nowMs = await $.clock.now()
  if (verb === 'list' || verb === 'all') {
    const l = await readLedger($, file)
    return { text: l ? listing(l, nowMs, { all: verb === 'all' }) : 'ledger: the file could not be read just now' }
  }
  if (verb === 'close' && arg) {
    let found = false
    await changeLedger($, l => { const n = closeByHand(l, arg, nowMs); found = Boolean(n); return n })
    return { text: found ? `ledger: closed ${arg}` : `ledger: no open item ${arg}` }
  }
  if (verb === 'clear') {
    await changeLedger($, l => clearOpen(l, nowMs))
    return { text: 'ledger: every open item closed (the history stays in the file)' }
  }
  return { text: 'usage: /ledger [list|all|close <id>|clear]' }
}
