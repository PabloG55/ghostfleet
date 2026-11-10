// ghostfleet's mod: the fleet's view of a Claude session, from inside the session.
//
// Everything the fleet knew about a Claude session it learned from OUTSIDE: a regex over
// the captured pane for "is it working" (blind at 56 columns, fooled by a leftover login
// line, by prose that quotes a spinner), the status bar scraped for the 5h budget (gone
// below ~100 columns, frozen on an idle pane), and a lead spending a whole turn to run
// fleet-inbox through Bash. From in here there is nothing to guess: a turn starts, a turn
// completes, a dialog is about to be drawn, the engine measures the account.
//
// Eight things, each a section below, all sharing the record I/O at the top:
//   STATE     written into the session's status record as it changes
//   BUDGET    the account's rate-limit windows, from the engine's own measurement
//   COMMANDS  /fleet and /inbox, answered without a turn
//   DELIVERY  the fleet's prompts, submitted as turns of their own
//   GUARDS    the fleet's refusals in front of Bash and the MCP tools, failing CLOSED
//   BAND      a lead's team above its prompt
//   LEDGER    every request made of the session, held open until a final message answers it
//   PEEK      a pasted [Image #N] previewed on hover, while writing and after (experimental: `peek`)
// What is written is shaped by ./shape.js, ./handoff.js, ./guard-shape.js, ./band-shape.js,
// ./ledger.js and ./peek-shape.js, plain functions the suite can run with node (./peek-window.js
// is a string, the program PEEK runs; ./peek-chip.js is a surface module, which the engine loads
// apart and which has no `$`). The engine follows `$` only into functions declared in this file, never across an import, which is why the hooks are one file and not six.
//
// THE OBSERVERS DECIDE NOTHING, THE GUARDS DECIDE AND FAIL CLOSED. STATE, BUDGET, COMMANDS,
// BAND and PEEK only observe: a hook of theirs that throws or runs out of time is skipped and the
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
  withState, stateAfterTurn, usageRecord, sockOfTmux, asksAPerson, codeId, isCodeFile,
} from './shape.js'
import {
  mergesAPr, changesABoundary, isMergeTool, prSelector, boundaryOn, mergeRefusal,
  SETTING_REFUSAL, failedClosed, answerCalls, JARVIS_TOOLS, fleetTool, callArgs, markerSock,
  jarvisMightAct,
} from './guard-shape.js'
import { teamOf, latestBySlot, summarize, prSummary, bandRuns, heldKinds, heldWake, heldRuns } from './band-shape.js'
import {
  ledgerFile, parseLedger, ledgerConfig, sourceOf, openItems, ledgerSummary,
  soundsLikeAPromise, judgePrompt, parseVerdict, applyVerdict, gateTargets, gatePrompt,
  markGated, closeByHand, clearOpen, listing, ledgerRuns, stampTurn, withdrawn, dropItems, turnBlocks,
  judgeBatches, JUDGE_TOKENS, gateHold, lastGateAt, isGateTurn, countJudge, adoptLedger,
  markInterrupted, addPrompt, closeByAgent, dropByAgent, addByAgent, contextNote, promptNotes, TOOL,
  revisitTurn, expireDormant, endsOnChoice, askedIn, proofTargets, proofPrompt, markProofAsked, settleTurn, closedInTurn,
  deliverySource, ledgerChanges,
} from './ledger.js'
import { inferFacts, INFER_MODEL, INFER_TOKENS, INFER_MS } from './know-shape.js'
import {
  pastesIn, sameIds, sessionDirs, storedImage, EXT, pairPastes, pastesFromApi, fromBase64, sniff, decodePng, thumb,
  ffmpegFileArgv, NO_FFMPEG, parsePam, fitCells, rasterOf, caption, WHY, platformOf, previewMode, WINDOW, openArgv,
  SHRINKERS, shrinkArgv, tokenTargets, listedTargets, chipOf,
  asksClient, CLIENT_FORMAT, lookingClient, drawsAlt, refusalNote, sendsBytes, imageSource, decodedSize, PNG_MAX,
  KITTY_SIDE, kittySides,
} from './peek-shape.js'
import { PEEK_WINDOW } from './peek-window.js'
import {
  spoolOf, entryId, waiting, staleReceipts, replyOf, replyMarker, armedMarker, isTurnOf,
  commandOf, failureOf, headOf,
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
//
// AN AGENT STARTED BY AN AGENT inherits that agent's environment whole — a probe a worker
// runs from its Bash tool carries the worker's $TMUX, pane and slot. The shell hook sees it
// in the process tree and writes the record with no slot and `nested_under` set, and that
// mark is the answer here too: the environment would hand this session the worker's queue,
// its inbox and its team.
async function identity($, rec) {
  if (rec && rec.nested_under) return { sock: '', slot: '' }
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
  return patchRecord($, rec => withState(rec, next, { nowMs, pid, turnId, code: codeLoaded || '' }))
}

// The code this process loaded (shape.js codeId says why `v` cannot tell): read once, at the
// first session.start of this module, and never again. A reload starts the module over and so
// reads it afresh; a /clear is the same module, and reading again then would describe whatever
// is on disk now rather than what is running. '' is "could not be read", reported as nothing,
// which a reader takes as not known to be current.
let codeLoaded = null
const CODE_READ_MS = 30_000
async function readCode($) {
  if (codeLoaded !== null) return codeLoaded
  codeLoaded = ''
  const dir = `${$.plugin.root}/hooks`
  // Slow is waited for, because nothing waits on this past the start's own bound (startState);
  // only a filesystem that never answers is given up on.
  const list = await bounded($, $.fs.list(dir), CODE_READ_MS, null)
  if (!list) return codeLoaded
  const names = list.filter(e => e && e.kind === 'file' && isCodeFile(e.name)).map(e => e.name)
  const texts = await Promise.all(names.map(name => bounded($, $.fs.read(`${dir}/${name}`), CODE_READ_MS, null)))
  if (texts.some(t => typeof t !== 'string')) return codeLoaded
  codeLoaded = names.length ? codeId(names.map((name, i) => ({ name, text: texts[i] }))) : ''
  return codeLoaded
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
  // The start waits for the code as long as it can spare, and no longer. Measured on a scratch
  // session started while the machine was busy: the read outlasted that, the record was written
  // without it, and an idle session writes nothing again but its heartbeat, so it named no code
  // for as long as it sat there, which `fleet-mod reload` reads as stale. So a read that lands
  // late patches its answer in, into a record of this process that has none yet.
  const reading = readCode($)
  await bounded($, reading, IO_MS * 3, '')
  // A resumed conversation's record can still say `working` from the process that died
  // mid-turn; this process has started no turn, so say what it IS doing.
  const turns = await bounded($, $.session.turns(), IO_MS, 0)
  const first = turns > 0 ? 'ready' : 'idle'
  // The shell hook's SessionStart may not have written the record yet: try once more a
  // moment later, rather than creating it here.
  if (!(await setState($, first))) {
    $.clock.after(2000, () => { if (state === first) setState($, first) })
  }
  void reading.then(code => code && patchRecord($, rec => (rec.mod && pid && rec.mod.pid === pid && !rec.mod.code)
    ? { ...rec, mod: { ...rec.mod, code } } : null)).catch(() => {})
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
  if (e.agentId === undefined) {
    const blocks = takeSteps(e)
    void ledgerTurnComplete($, e, blocks).catch(() => {})
    void knowTurnComplete($, e, blocks).catch(() => {})       // KNOW: also never awaited
  }
  if (e.agentId === undefined) await peekTurnComplete($)
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
  peekEnd()
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
// section can name exactly. A prompt that opens with a slash command (`/skill args`) is the
// one exception: the host refuses it to `$.prompt.submit`, so it goes through
// `$.command.run`, which runs it as if typed and starts its turn the same way
// (./handoff.js commandOf has the measurements).
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
//   this claims it (.json -> .taken) only while no turn runs, and marks it submitted
//     (.taken -> .sent) in the instant before it submits; at the turn.start whose text is
//     that prompt it writes <id>.done with the turnId and arms the prompt's reply address,
//     if it has one, for THAT turn;
//   fleet-send, finding the entry unclaimed when its window closes, takes it back
//     (.json -> .revoked) and pastes. The loser of a rename knows it lost, so a prompt is
//     never both submitted and pasted.
//
// `.taken` AND `.sent` ARE TWO STATES BECAUSE A RESTART CANNOT TELL THEM APART OTHERWISE.
// A process that starts on this conversation finds what the last one left: a claim it never
// submitted is put back and delivered again, which is what makes a crash cost nothing. A
// claim it DID submit must never be, and with one state for both it was: `/reload-plugins`
// delivered through here reloads this mod inside its own `$.command.run`, the reload drops the
// old environment's timers before its receipt is written, and the new one found `.taken`, put
// it back, and ran the reload again. Measured: one send, 65 reloads before it was cut off by
// hand, and the sender's "could not confirm submit" was the only sign. So the submit is
// written down before it is made, and a process that finds `.sent` resumes waiting for that
// prompt's turn (DELIVERY_SENT keeps its ledger items across a reload) and never submits it.
// The one window left is the rename itself: a crash between `.sent` and the call loses that
// one prompt, which is the side to err on: a prompt run twice is work done twice, and a
// command run twice can be a loop.
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
// How long a command run that resolved may take to start its turn before it is taken to have
// started none. Measured: a skill's run resolves and its turn.start lands in the same
// millisecond; a panel command (/cost) resolves once its panel closes, with no turn at all.
const RAN_MS = 10_000
// The slash commands this mod registers and answers itself (COMMANDS, LEDGER).
const OWN_COMMANDS = ['fleet', 'inbox', 'ledger']

// The prompt submitted and not yet started, by id, with the ledger items its claim made: in
// $.state, so the process a reload starts can still stamp or undo them.
const DELIVERY_SENT = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'deliverySent' })

let turnRunning = false
let pending = null                         // { id, text, command, reply, at, resumed? }: claimed, not started
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

// A failure also names the session it failed in, so fleet-inbox can put it in front of that
// session's lead when no sender read it (lib/handoff-sweep.mjs): by then the session that
// wrote it may have ended and taken its status record with it.
async function receipt($, id, fields) {
  const nowMs = await $.clock.now()
  let who = {}
  if (failureOf(fields)) {
    const rec = await readRecord($, `${await fleetDir($)}/${deliverSid}.json`)
    if (rec && rec.sock && rec.slot) who = { sock: rec.sock, slot: rec.slot }
  }
  await writeSpool($, spool, `${id}.done`, JSON.stringify({ id, ...fields, ...who, at: nowMs }))
  await runBounded($, ['rm', '-f', `${spool}/${id}.taken`, `${spool}/${id}.sent`])
  const sent = await soon($, $.state.get(DELIVERY_SENT), null)
  if (sent && sent.value && sent.value.id === id) await soon($, $.state.set(DELIVERY_SENT, null), null)
}

// Receipts past the hour go, except a failure: nobody read it (fleet-send removes the ones it
// reported), so it is kept as <id>.failed for fleet-inbox to report and clear.
async function clearReceipts($, dir, names) {
  const gone = []
  for (const n of names) {
    const r = await readRecord($, `${dir}/${n}`)
    if (failureOf(r)) await runBounded($, ['mv', '-f', `${dir}/${n}`, `${dir}/${entryId(n, '.done')}.failed`])
    else gone.push(`${dir}/${n}`)
  }
  if (gone.length) await runBounded($, ['rm', '-f', ...gone])
}

// One at a time, and only while idle: a prompt claimed mid-turn would sit inside the
// engine, where fleet-send can no longer take it back and nothing shows it waiting.
async function deliverTick($) {
  if (!claiming && pending && !turnRunning) await expirePending($)
  if (claiming || pending || turnRunning || !spool) return
  claiming = true
  try {
    const entries = await bounded($, $.fs.list(spool), IO_MS, null)
    if (!entries) return
    const nowMs = await $.clock.now()
    const old = staleReceipts(entries, nowMs)
    if (old.length) await bounded($, clearReceipts($, spool, old), IO_MS * 2, null)
    const id = waiting(entries)[0]
    if (!id) return
    const took = await runBounded($, ['mv', `${spool}/${id}.json`, `${spool}/${id}.taken`])
    if (took?.exitCode !== 0) return                     // revoked under us: it is theirs
    const entry = await readRecord($, `${spool}/${id}.taken`)
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) {
      await receipt($, id, { error: 'unreadable entry' })
      return
    }
    const cmd = commandOf(entry.text)
    // This mod's own commands cannot be run from here: the host runs a plugin's
    // `$.command.run` through every hook but that plugin's own, so measured, `/fleet` ran
    // and printed "no command.run hook answered it", and its receipt said it had run.
    const own = cmd && OWN_COMMANDS.includes(cmd.command)
      ? `/${cmd.command} is this session's own ghostfleet command, which its delivery cannot run (the host skips a plugin's own hooks on its own run); run fleet-${cmd.command === 'fleet' ? 'list' : cmd.command} instead` : ''
    if (cmd && (cmd.refused || own)) {
      await receipt($, id, { error: cmd.refused || own, head: headOf(entry.text) })
      return
    }
    // `kind: "nudge"`: a wake-up fleet-send was told is one (--nudge), never a request.
    // `kind: "owner"`: the owner's own words, from a sender that authenticated them
    // (fleet-send --owner; ledger.js deliverySource), recorded as the person's.
    pending = { id, text: entry.text, command: cmd, reply: replyOf(entry), at: nowMs, nudge: entry.kind === 'nudge', owner: entry.kind === 'owner' }
    // The ledger's item for it is made HERE: a plugin's own submit passes every prompt.submit
    // hook but its own, so LEDGER's never sees it.
    await ledgerDelivery($, pending)
    // INTO JARVIS'S MASTER, the fleet's words are marked as the fleet's before they are
    // submitted: the event hook that records the owner's yes runs on this submit and skips
    // what a mark accounts for (lib/jarvis.mjs consumeDelivery). Marked here and not by the
    // sender, because this is the session that receives, under the HOME that hook reads.
    if (await maybeJarvis($).catch(() => false))
      await bounded($, guardRun($, [bin($, 'fleet-jarvis'), 'delivered'], { stdin: entry.text }), GUARD_MS + 500, null)
    // Settles once the turn started or the engine queued it; turn.start is what names the
    // turn, so this is not awaited for that. A refusal is answered here. A command run that
    // settles and starts no turn within RAN_MS ran without one (a panel, a local command):
    // its receipt says it ran, which is a delivery, and its ledger item goes, as nothing
    // will ever answer it.
    const settled = r => (r && r.drop !== undefined ? { dropped: String(r.drop) } : null)
    const lost = () => ledgerLost($, pending)
    const ranAlone = async () => {
      await $.clock.sleep(RAN_MS)
      if (pending?.id === id) { await lost(); pending = null; await receipt($, id, { ran: `/${cmd.command}` }) }
    }
    // Written down before it is made (`.sent`, above). A rename that fails means the sender
    // took the claim back (fleet-send does that to a wake it gave up on) and delivers it
    // itself; one whose answer was lost to the bound is asked of the file.
    await soon($, $.state.set(DELIVERY_SENT, { id, ledgered: pending.ledgered || [], made: pending.ledgerMade || [] }), null)
    const marked = await runBounded($, ['mv', `${spool}/${id}.taken`, `${spool}/${id}.sent`])
    if (marked?.exitCode !== 0 && (await bounded($, $.fs.exists(`${spool}/${id}.sent`), IO_MS, false)) !== true) {
      await lost(); pending = null
      await soon($, $.state.set(DELIVERY_SENT, null), null)
      return
    }
    const run = cmd ? $.command.run({ command: cmd.command, args: cmd.args }) : $.prompt.submit({ text: entry.text, asUser: true })
    Promise.resolve(run).then(
      async r => {
        const d = settled(r)
        if (d && pending?.id === id) { await lost(); pending = null; await receipt($, id, { ...d, head: headOf(entry.text) }) }
        else if (cmd && pending?.id === id) await ranAlone()
      },
      async err => { if (pending?.id === id) { await lost(); pending = null; await receipt($, id, { error: String(err?.message || err), head: headOf(entry.text) }) } })
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
      else if (!p.nudge) await ledgerFleetItem($, p, e.turnId)
    })(), IO_MS * 4, null)
  } else if (p) await expirePending($)
}

// A CLAIM WHOSE TURN NEVER STARTED IS WRITTEN OFF ON THE POLL, NOT ONLY AT THE NEXT TURN.
// This used to be checked at turn.start alone, and on a lead that sits idle no turn starts:
// `pending` stayed set, deliverTick returned at its first line for as long as the session
// lived, and every later handoff waited out its claim window and was taken back. The receipt
// that would have said why was never written either. So the poll asks too, while no turn
// runs. A claim the sender already took back (its `.taken` renamed away: fleet-send does
// that to a wake it gave up on) is let go without a receipt, because that sender delivered
// it another way and a failure written now would be reported as one nobody read.
//   A command a restart RESUMED has no run of its own left to settle, so it is held to RAN_MS,
// the wait its own run would have had: the commonest is the `/reload-plugins` that started
// this very process, which ran and started no turn, and its receipt says exactly that.
async function expirePending($) {
  const p = pending
  const ran = Boolean(p && p.resumed && p.command && !p.command.refused)
  if (!p || (await $.clock.now()) - p.at <= (ran ? RAN_MS : START_MS)) return
  pending = null
  const held = await bounded($, $.fs.exists(`${spool}/${p.id}.sent`), IO_MS, null)
  if (held === false) return
  if (ran) await ledgerLost($, p)
  await bounded($, receipt($, p.id, ran ? { ran: `/${p.command.command}` } : { error: 'its turn never started', head: headOf(p.text) }), IO_MS * 2, null)
}

// The ledger items a claim made and nothing will answer now (a refusal, a command that started
// no turn): undone, those alone (ledgerDelivery says why `made` and not `ledgered`).
async function ledgerLost($, p) {
  const m = p?.ledgerMade || p?.ledgered
  if (m?.length) await ledgerUndo($, m)
}

// What a process finds that the one before it on this conversation submitted: waited for, as
// that one would have, and never submitted again. The newest is resumed; one older than it is
// from a process before that, whose turn has had its chance, and is written off as expirePending
// would have written it off.
async function resumeSent($, dir, ids) {
  const nowMs = await $.clock.now()
  const st = await soon($, $.state.get(DELIVERY_SENT), null)
  const kept = st && st.value ? st.value : null
  const all = [...ids].sort()
  for (const [i, id] of all.entries()) {
    const entry = await readRecord($, `${dir}/${id}.sent`)
    const text = entry && typeof entry.text === 'string' ? entry.text : ''
    const p = {
      id, text, command: commandOf(text), reply: replyOf(entry), at: nowMs, resumed: true,
      nudge: entry?.kind === 'nudge', owner: entry?.kind === 'owner',
      ...(kept && kept.id === id ? { ledgered: kept.ledgered, ledgerMade: kept.made } : {}),
    }
    if (i === all.length - 1) { pending = p; continue }
    pending = { ...p, at: -Infinity }
    await expirePending($)
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
    // A claim an earlier process of this conversation made and never submitted goes back,
    // so the next tick delivers it instead of leaving it stranded as `.taken`. One it DID
    // submit (`.sent`) is waited for and never submitted again (the section's head says why).
    const sent = []
    for (const t of (await bounded($, $.fs.list(dir), IO_MS, null)) || []) {
      if (!t || t.kind !== 'file') continue
      const id = entryId(t.name, '.taken')
      if (id) await runBounded($, ['mv', '-n', `${dir}/${id}.taken`, `${dir}/${id}.json`])
      const was = entryId(t.name, '.sent')
      if (was) sent.push(was)
    }
    spool = dir
    deliverSid = sid
    pending = null
    turnRunning = false
    if (sent.length) await resumeSent($, dir, sent)
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
  await peekStart($, e)
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
  // One AbovePrompt hook for the band and PEEK's row: the band's rows, then PEEK's, then the slot
  // as the hooks beneath left it (onBandRender says why it is always passed on).
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => onBandRender($, e, ee => onPeekBand($, ee, next)))
  on('prompt.submit', onPromptSubmit)
  on('command.run', { command: 'ledger' }, onLedgerCommand)
  // Spelled out, not TOOL.*: `claude plugin validate` reads a matcher only from its literal.
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_close' }, onLedgerTool)
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_drop' }, onLedgerTool)
  on('tool.call', { tool: 'mcp__ghostfleet__ledger_add' }, onLedgerTool)
  // PEEK: every hook answers `next(e)` untouched while the switch is off. Its session.start,
  // session.end, turn.complete and prompt.submit parts ride in the hooks above, and its
  // AbovePrompt row in the band's hook.
  on('prompt.edit', onPeekEdit)
  on('ui.message', onPeekMessage)
  on('ui.render', { component: 'UserMessage' }, onPeekSent)
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
  const nowMs = await $.clock.now()
  const s = summarize(team, bySlot, nowMs)
  await publish($, { ...s, prs, held: await heldOf($, dir, entries, who.sock, who.slot, nowMs) })
}

// A wake the fleet is holding because THIS session's input box never read empty
// (band-shape.js heldWake). Its age is drawn against a minute bucket, like the ledger's, so
// the band redraws once a minute while it lasts and not on every tick.
async function heldOf($, dir, entries, sock, me, nowMs) {
  const names = new Set(heldKinds(me).map(k => `${sock}.${k}.blocked`))
  const files = []
  for (const f of entries) {
    if (f.kind !== 'file' || !names.has(f.name)) continue
    files.push({ name: f.name, mtimeMs: f.mtimeMs, text: String(await soon($, $.fs.read(`${dir}/${f.name}`), '')) })
  }
  const held = heldWake(files, sock, me, nowMs)
  return held ? { ...held, asOf: Math.floor(nowMs / 60_000) * 60_000 } : null
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

// A held wake first (it is about the box right below), then the team's row, then the
// ledger's (LEDGER, below), each only when it has something to say, and then whatever the
// hooks beneath put in the slot. AbovePrompt is ONE slot shared by every mod and by this
// mod's own PEEK row: a tree answered without `next(e)` is the whole slot, so the band
// showing its team used to make every other row above the prompt disappear.
async function onBandRender($, e, next) {
  if (e.props.hasSurvey) return next(e)
  const { value } = await $.state.get(BAND)
  const team = value ? bandRuns(value, value.prs, e.props.bodyColumns) : null
  const hold = value && value.held ? heldRuns(value.held, value.held.asOf, e.props.bodyColumns) : null
  const led = (await $.state.get(LEDGER)).value
  const book = led ? ledgerRuns(led, led.asOf, e.props.bodyColumns) : null
  const below = await next(e)
  if (!team && !hold && !book) return below
  const { Box, Text } = $.ui.resolve(e)
  const row = (runs, k) => h(Box, { key: k, flexDirection: 'row' },
    ...runs.map((r, i) => h(Text, {
      key: String(i), wrap: 'truncate-end',
      ...(r.color ? { color: r.color } : {}), ...(r.dim ? { dimColor: true } : {}), ...(r.bold ? { bold: true } : {}),
    }, r.text)))
  return h(Box, { flexDirection: 'column' }, ...(hold ? [row(hold, 'held')] : []), ...(team ? [row(team, 'team')] : []),
    ...(book ? [row(book, 'ledger')] : []), ...(below ? [below] : []))
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
//   TURN     the person's own message is turn-scoped: judged at the end of the turn that
//            answers it, but on the band, the record and the prompt's note only once it
//            outlives that turn (ledger.js owed). Every turn end settles it, a failed or
//            skipped judge and an Esc included, so it fails open (settleOf)
//   JUDGE    at a main-loop turn.complete that ended with an answer, a small-model call per
//            ten open items (when something is open, or the answer sounds like a promise):
//            which open items the turn's text, all of it, addressed, and what its final text
//            promised. A promise kept open through five judged turns closes as stale
//   GATE     items still open after that get ONE re-prompt, ever, naming them; never an
//            item the turn reported in progress, and never at all at the end of a turn the
//            gate itself started, one that ends on a question to the person, one inside the
//            cooldown, or a lead's while its workers are still at it (gateHold)
//   PROOF    a brief from the lead (`fleet`) the judge reads as done stays open: only
//            ledger_close with proof closes it. The same re-prompt, under the same holds, asks
//            for that proof ONCE per brief, ever (ledger.js proofTargets)
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
let turnStarts = new Map() // turnId -> when it started, for the last few turns (settleTurn, closedInTurn)
let answers = []         // the last few judged turns: { at, turnId, blocks }
let stepTexts = new Map() // turnId -> the text each of its main-loop steps wrote, in order
let ledgerShown = ''     // what the band and the record last said
let ledgerAsOf = 0
let gateTurns = []       // the last few turns the gate's own re-prompt started
let choiceTurn = ''      // the last turn, when it ended on a numbered question (ledger.js foldReply)
let choiceAsked = ''     // ...and what it asked, for quoting beside the answer (ledger.js askedIn)
let personTexts = []     // the person's own messages, submitted and not yet started as a turn
let personTurns = []     // the last few turns one of those started (ledger.js revisitTurn)

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
  knowLedger($, dir, file, ledgerChanges(cur, next))
  await showLedger($, next)
  return next
}

// ── KNOW: the fleet's memory (docs/MEMORY.md) ──────────────────────────────
// Two things only, and neither may slow a turn: what a ledger write changed goes to
// bin/fleet-know-event (the one writer), and — behind fleet-experimental's know-infer, OFF by
// default — a finished turn is read by a small model for the decisions in it. Both are fired
// and not awaited; a failure costs a fact, never the write or the turn.
function knowLedger($, dir, file, changes) {
  if (!changes.length) return
  const sid = file.slice(dir.length + 1).replace(/\.ledger$/, '')
  void $.process.run([bin($, 'fleet-know-event'), 'ledger', `session=${sid}`, `fleet=${dir}`, 'via=mod'],
    { stdin: JSON.stringify(changes), timeoutMs: KNOW_MS }).catch(() => {})
}
const KNOW_MS = 5000
async function knowInferOn($) {
  const dir = (await $.env.get('CLAUDE_FLEET_EXPERIMENTAL_DIR')) || `${await $.env.get('HOME')}/.config/ghostfleet`
  const text = await soon($, $.fs.read(`${dir}/know-infer.enabled`), '')
  return /^\s*on\s*$/.test(String(text))
}
// The privacy answer comes from the writer itself (`fleet-know-event privacy`), the same code
// that decides what the log records, so the gate here and the log can never disagree. Its
// absence, a timeout or a non-zero exit is the empty answer, and know-shape.js refuses it.
async function knowTurnComplete($, e, blocks) {
  if (e.reason !== 'answer') return
  const enabled = await knowInferOn($)
  if (!enabled) return
  const sid = await $.session.id()
  if (!sid) return
  const dir = await fleetDir($)
  const asked = await bounded($, $.process.run([bin($, 'fleet-know-event'), 'privacy', `session=${sid}`, `fleet=${dir}`], { timeoutMs: KNOW_MS }), KNOW_MS + 500, null)
  const mode = asked && asked.exitCode === 0 ? String(asked.stdout || '').trim() : ''
  const r = await inferFacts({
    enabled, mode, turn: blocks.join('\n\n'),
    call: prompt => $.model.complete({ model: INFER_MODEL, prompt, maxTokens: INFER_TOKENS, effort: 'low', timeoutMs: INFER_MS }),
  })
  if (r.failed) void $.ui.log(`ghostfleet know: inferred pass failed (${r.failed}); nothing recorded`, { to: 'debug' })
  if (!r.facts.length) return
  await bounded($, $.process.run([bin($, 'fleet-know-event'), 'infer', `session=${sid}`, `turn=${e.turnId}`, `fleet=${dir}`],
    { stdin: JSON.stringify(r.facts), timeoutMs: KNOW_MS }), KNOW_MS + 500, null)
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
  if (file && adoptedFor !== file) { adoptedFor = file; await bounded($, adoptMoved($, file), IO_MS * 6, null) }
  const l = file ? await readLedger($, file) : null
  if (l) await showLedger($, l)
}

// WHAT THIS SESSION LEFT UNDER ANOTHER PROFILE, BROUGHT HERE (ledger.js adoptLedger). Asked
// once per session id per process, on the first band tick that knows the id: a resume under
// another profile is a new process, so that is when the old file appears. Every other
// profile's fleet dir is <HOME>/.claude or <HOME>/.claude-<name>, as fleet-open finds a
// transcript. A dir is "this one" by its REAL path, never by its spelling: a fleet dir reached
// through a link is the same dir, and taking this session's own file for the old copy would
// mark every item it owes as moved. When either path cannot be resolved, that dir is skipped.
// Nothing here makes a new ledger in another profile or deletes one; the old file is rewritten
// only when nobody changed it while this read it, and a lost race is retried at the next start.
let adoptedFor = ''
async function adoptMoved($, file) {
  const here = file.slice(0, file.lastIndexOf('/'))
  const name = file.slice(here.length + 1)
  const real = async p => { try { return (await $.fs.stat(p, { resolve: true })).realPath || '' } catch { return '' } }
  const hereReal = await real(here)
  const home = await $.env.get('HOME')
  if (!hereReal || !home) return
  const entries = await $.fs.list(home).catch(() => [])
  const dirs = entries.filter(e => (e.kind === 'dir' || e.isLink) && /^\.claude(-[A-Za-z0-9._-]+)?$/.test(e.name))
    .map(e => `${home}/${e.name}/fleet`)
  for (const dir of dirs) {
    const dirReal = await real(dir)
    if (!dirReal || dirReal === hereReal) continue
    const other = `${dir}/${name}`
    if (!(await $.fs.exists(other).catch(() => false))) continue
    const before = await $.fs.read(other).catch(() => null)
    if (before === null) continue
    let old
    try { old = JSON.parse(before) } catch { continue }
    if (!old || !Array.isArray(old.items)) continue
    const nowMs = await $.clock.now()
    let r = null
    const wrote = await changeLedger($, l => { r = adoptLedger(l, parseLedger(before), { from: dir, to: here, nowMs }); return r && r.here })
    // This ledger first: unread here (null, and the change never ran) leaves the old file as it is.
    if (!r || (r.here && !wrote)) continue
    const tmp = `${dir}/.${name}.moved.tmp`
    await $.fs.write(tmp, JSON.stringify(r.old))
    const now = await $.fs.read(other).catch(() => null)
    const ok = now === before && (await $.process.run(['mv', '-f', tmp, other], { timeoutMs: IO_MS })).exitCode === 0
    if (!ok) await $.process.run(['rm', '-f', tmp], { timeoutMs: IO_MS }).catch(() => {})
    void $.ui.log(`ghostfleet ledger: ${r.moved} item(s) this session owed under ${dir} ${ok ? 'moved here' : 'copied here; the old file changed, marked next start'}`
      + ` (${r.added} added, ${r.back} back)`, { to: 'debug' })
  }
}

// Recorded BEFORE `next`, so the note the prompt carries can name its own items by id; the
// turn they belong to is stamped after, once `next` has started it. A slash command is the
// harness's, and carries nothing.
async function onPromptSubmit($, e, next) {
  await peekPrompt($, e)
  const r = await ledgerPromptSubmit($, e, next)
  await peekSubmitted($, e)
  return r
}

async function ledgerPromptSubmit($, e, next) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on || String(e.text || '').trimStart().startsWith('/')) return next(e)
  const before = currentTurn
  const at = await $.clock.now()
  const source = sourceOf(e)
  const ids = []
  const made = []
  let window = 0
  let cur = source ? await changeLedger($, l => {
    window = Number(l.window) || 0
    return addPrompt(l, { text: e.text, at, turnId: e.turnId || '', source, queued: Boolean(e.turnId), choiceTurn, asked: choiceAsked }, ids, made)
  }) : null
  if (!cur) {
    const file = await ledgerPath($)
    cur = file ? await readLedger($, file) : null
  }
  // A status question also carries what is held for the person (ledger.js statusNote):
  // waiting items are on neither the open list nor contextNote, so without it the answer
  // to "whats the status" was whatever the model remembered of the turn that asked.
  const notes = cur ? promptNotes(cur, e.text, at) : []
  if (source) notePerson(e.text)
  const r = await next(notes.length ? { ...e, context: [...(e.context || []), ...notes] } : e)
  if (!ids.length) return r
  if (!r || r.drop !== undefined) {
    // It never entered: its items go, and the window goes back to the one before. An item it
    // only touched (a resend, a reply) was there before it, and stays.
    await changeLedger($, l => ({ ...dropItems(l, made), window }))
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

// WHICH TURNS THE PERSON STARTED: their own message, typed (sourceOf) or delivered as the
// owner's (deliverySource), never a nudge, the gate's re-prompt or a lead's brief. Known by the
// text, as stampTurn knows a turn: the message is noted when it is submitted (one typed over a
// running turn starts its own turn later) and the turn.start that carries it is theirs. Its
// judge is shown their waiting items (ledger.js revisitTurn).
function notePerson(text) {
  const t = String(text || '').trim()
  if (t) personTexts = [...personTexts.filter(x => x !== t), t].slice(-6)
}

async function ledgerTurnStart($, e) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  turnStarts.set(e.turnId, await $.clock.now())
  while (turnStarts.size > 8) turnStarts.delete(turnStarts.keys().next().value)
  if (!e.text) return
  if (isGateTurn(e.text)) gateTurns = [...gateTurns, e.turnId].slice(-4)
  const said = String(e.text).trim()
  if (personTexts.includes(said)) {
    personTexts = personTexts.filter(x => x !== said)
    personTurns = [...personTurns, e.turnId].slice(-4)
  }
  await changeLedger($, l => stampTurn(l, e.text, e.turnId))
}

// A prompt fleet-send handed over, as DELIVERY claims it: a lead's brief is one item (not
// split into its sentences) in a window of its own; the owner's own words (`owner`) are the
// person's, split into asks like a typed message; a nudge is nothing (ledger.js
// deliverySource). Its turn.start stamps the items with the turn and arms the note
// (ledgerNoteOnTool).
const deliveryKind = p => (p.nudge ? 'nudge' : p.owner ? 'owner' : '')
async function ledgerDelivery($, p) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  const at = await $.clock.now()
  const ids = []
  const made = []
  const source = deliverySource(deliveryKind(p))
  if (source) await changeLedger($, l => addPrompt(l, { text: p.text, at, source, whole: source === 'fleet' }, ids, made))
  if (source === 'user') notePerson(p.text)
  // `ledgered` is every item it names (its turn stamps them); `ledgerMade` only the ones it
  // created. A delivery that never lands undoes those alone: a brief sent twice folds into the
  // first copy (ledger.js repeatOf), and undoing the second send must not delete the first.
  p.ledgered = ids
  p.ledgerMade = made
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
async function ledgerFleetItem($, p, turnId) {
  const cfg = await ledgerConfigOf($)
  if (!cfg.on) return
  const source = deliverySource(deliveryKind(p))
  if (!source) return
  if (source === 'user') personTurns = [...personTurns, turnId].slice(-4)
  const at = await $.clock.now()
  await changeLedger($, l => addPrompt(l, { text: p.text, at, turnId, source, whole: source === 'fleet' }))
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
  const at = await $.clock.now()
  choiceTurn = e.reason === 'answer' && endsOnChoice(blocks[blocks.length - 1]) ? e.turnId : ''
  choiceAsked = choiceTurn ? askedIn(blocks[blocks.length - 1]) : ''
  if (e.reason === 'aborted') await changeLedger($, l => markInterrupted(l, e.turnId, at))
  if (e.reason !== 'answer') { await settleOf($, e.turnId, generation); return }
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
  // Whatever the judge did (closed, kept open, failed, skipped, threw), the turn is over: what
  // it left open is owed from here (ledger.js settleTurn). After the gate, which is unchanged.
  await settleOf($, e.turnId, generation)
  const queued = judgeNext
  judgeNext = null
  if (queued) {
    answers = answers.filter(a => a.turnId !== queued.e.turnId)
    await ledgerTurnComplete($, queued.e, queued.blocks, queued.generation)
  }
}

// The end of turn `turnId` settles the turn-scoped marks it answers (ledger.js settleTurn).
async function settleOf($, turnId, generation) {
  const startedAt = turnStarts.get(turnId) || 0
  await changeLedger($, l => settleTurn(l, { turnId, startedAt, movedOn: turnsStarted !== generation }))
}

// `blocks`: every text block the turn wrote. `generation`: how many turns had started when
// this one ended.
async function judgeTurn($, cfg, e, blocks, nowMs, generation) {
  const surfaces = await bounded($, $.session.surfaces(), IO_MS, null)
  if (!surfaces || !surfaces.length) return                  // -p, the SDK: nobody to nag
  const file = await ledgerPath($)
  if (!file) return
  await changeLedger($, l => expireDormant(l, nowMs))
  const cur = await readLedger($, file)
  if (!cur) return
  // The judge is the backup: it reads only what is still open after the agent's own closes
  // (ledger_close, ledger_drop), and a turn whose agent closed everything costs no call at
  // all, not even the promise read: an agent that closes its items with proof is the one
  // the hybrid is for, and a call per turn to second-guess it is the cost it removes. A close
  // from Bash (fleet-ledger) carries no turn, and counts by its time (ledger.js closedInTurn).
  // `open` is every open item, the turn's own turn-scoped ones too: the judge reads them.
  const open = openItems(cur, nowMs)
  const closedOwn = closedInTurn(cur, { turnId: e.turnId, startedAt: turnStarts.get(e.turnId) || 0 })
  const promises = cfg.promises !== 'off' && soundsLikeAPromise(e.answer)
  // A stale or waiting item this turn mentions is judged with them, and on a turn the person's
  // own message started, every waiting item still inside its day (ledger.js revisitTurn).
  const back = revisitTurn(cur, nowMs, blocks.join('\n'), { person: personTurns.includes(e.turnId) })
  if (!open.length && !back.length && (closedOwn || !promises)) return  // nothing to judge: no call
  // The turns since the oldest open item was made, this one last: a request answered one
  // turn ago and only referred to now ("I ended my previous reply with it") is still
  // answered.
  const since = open.length ? Math.min(...open.map(i => i.at)) : nowMs
  const earlier = answers.slice(0, -1).filter(a => a.at >= since).map(a => a.blocks)
  // In batches, newest first (ledger.js JUDGE_BATCH): one call for every open item ran out of
  // reply past ~20 items, and from then on every turn's judge failed. Promises are read once,
  // by the first call; the others are told to return none. The calls run one after another:
  // the newest batch is the one most likely to matter, and it lands first.
  const batches = open.length || back.length ? judgeBatches([...open, ...back]) : [[]]
  // The first call reads the turn's promises, so it is shown every open one to name the one a
  // phrase restates, whichever batch that promise is judged in.
  const openPromises = judgeBatches(open.filter(i => i.source === 'promise'))[0] || []
  let after = null
  const failed = []
  let answered = 0
  let waitingOnPerson = false
  const usage = []         // each call's `usage`, as the host reports it (ledger.js countJudge)
  for (const [k, batch] of batches.entries()) {
    const r = await $.model.complete({
      model: cfg.model, prompt: judgePrompt(batch, blocks, { ...cfg, promises: k ? 'off' : cfg.promises, earlier, openPromises }),
      maxTokens: JUDGE_TOKENS, effort: 'low', timeoutMs: JUDGE_MS,
    })
    if (r && r.usage) usage.push(r.usage)
    const verdict = r && r.isAnswered ? parseVerdict(r.text, batch.map(i => i.id)) : null
    if (!verdict) {
      failed.push(!r ? 'no result' : !r.isAnswered ? `${r.reason}${r.error ? ` ${r.error}` : ''}` : 'reply was not the JSON asked for')
      continue
    }
    // What a cut-off reply finished still applies; the items it never reached stay open.
    if (verdict.partial) failed.push(`reply cut off after ${verdict.items.length} of ${batch.length} items`)
    answered += verdict.items.length
    waitingOnPerson = waitingOnPerson || verdict.waitingOnPerson
    after = await changeLedger($, l => applyVerdict(l, verdict, { nowMs, turnId: e.turnId, promises: k ? 'off' : cfg.promises })) || after
  }
  const judge = failed.length
    ? { at: nowMs, ok: false, why: failed[0], items: answered, calls: batches.length, failedCalls: failed.length }
    : { at: nowMs, ok: true, items: answered, calls: batches.length }
  const kept = await changeLedger($, l => ({
    ...l, judge, judged: countJudge(l.judged, { at: nowMs, calls: batches.length, failedCalls: failed.length, items: answered, usage }),
  }))
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
  // Briefs this turn's verdict read as answered, owed their proof (ledger.js needsProof).
  let proof = proofTargets(after, nowMs, e.turnId)
  if (!targets.length && !proof.length) return
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
    proof = proof.filter(i => !gone.includes(i.id))
  }
  if (!targets.length && !proof.length) return
  // Each of these is a turn whose re-prompt could only be answered with the report it just
  // gave (ledger.js gateHold). The items stay open and un-gated: a later turn may still name them.
  const band = await bounded($, $.state.get(BAND), IO_MS, null)
  const team = band && band.value
  const held = gateHold({
    gateTurn: gateTurns.includes(e.turnId), waitingOnPerson, lastGate: lastGateAt(after), nowMs,
    workers: team ? (Number(team.working) || 0) + (Number(team.need) || 0) : 0,
  })
  if (held) {
    const heldItems = [...targets, ...proof].map(i => i.id)
    await changeLedger($, l => ({ ...l, judge: { ...(l.judge || judge), held, heldItems } }))
    void $.ui.log(`ghostfleet ledger: no re-prompt for ${heldItems.join(', ')} (${held})`, { to: 'debug' })
    return
  }
  const ids = targets.map(i => i.id)
  const asked = proof.map(i => i.id)
  // Marked BEFORE the submit: a crash between the two loses one nag, never adds a second.
  const marked = await changeLedger($, l => markProofAsked(markGated(l, ids, nowMs), asked, nowMs))
  if (!marked) return
  // Framed ("the ghostfleet plugin sent a message"), not asUser: it is the mod talking. One
  // submit, so the briefs owed proof and the ignored asks are one turn, not two.
  const text = [targets.length ? gatePrompt(targets) : '', proof.length ? proofPrompt(proof) : ''].filter(Boolean).join('\n\n')
  void Promise.resolve($.prompt.submit({ text })).catch(() => {})
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

// ── PEEK ────────────────────────────────────────────────────────────────────
//
// A pasted picture is `[Image #N]` in the prompt box and in the transcript, and nothing in the
// session lets it be looked at again. PEEK opens it on hover. EXPERIMENTAL (lib/experimental.mjs
// `peek`): switched off, no hook here changes anything, no image is read, nothing is started.
//
// WHERE THE POINTER GOES. Only the fullscreen layout (`"tui": "fullscreen"`) reports the
// pointer, so off it nothing here draws a target.
//   WHILE WRITING  the prompt box's text can be coloured by a mod but not hovered, so a row
//                  above the prompt lists the draft's `[Image #N]` as chips (./peek-chip.js).
//                  The draft is followed by `prompt.edit` and by a look at the box every
//                  PEEK_POLL_MS: a paste puts the placeholder in the box with no edit event.
//   AFTER SENDING  an unpainted chip over each `[Image #N]` on the sent prompt's first line
//                  (also a click target), and over each `  ⎿  [Image #N]` row Claude Code lists
//                  under it (hover only: a click there stays Claude Code's).
// A chip posts when the pointer comes onto it, moves on it and leaves it, and when it is
// clicked; `ui.message` opens the preview, closes it, or opens the picture in the viewer.
//
// WHAT THE PREVIEW IS (peek-shape.js previewMode): on macOS a panel by the pointer
// (./peek-window.js); where the terminal draws pictures, its own picture, inside tmux and over
// SSH too; anywhere else a card of cells. Both of those are a card drawn above the prompt, over
// the chips, whatever target opened it: the one place in the terminal a card lays out whole.
// Outside tmux it is decided once a session. Inside tmux the terminal is whichever one a person
// attached through, so tmux is asked again as each preview opens (peekDecide). A window program
// that ends without showing hands the rest of the session to cells, and so does the engine
// drawing one of these pictures as its alt (peekVerify): it decided when it started that the
// terminal draws none, and does not ask again.
//
// WHAT IT MAY OPEN. Only a paste of this session: Claude Code's own copy in the session's temp
// folder, or the bytes the prompt carried (at submit, or from the transcript) written into
// PEEK's folder beside it. A stored file must be a regular file and not a symbolic link, and
// its bytes must sniff as PNG, JPEG, GIF or WebP before anything is shown or converted.
//
// AN OBSERVER, like STATE and BAND: every call bounded, the work done off the hook that asked
// for it, and a picture that cannot be had is a line saying why.

const PEEK_ON = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'peekOn' })
const PEEK_DRAFT = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'peekDraft' })
const PEEK_PICS = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'peekPics' })
const PEEK_SHOWN = /** @type {const} */ ({ plugin: 'ghostfleet', key: 'peekShown' })
const PEEK_POLL_MS = 500
const PEEK_WAIT_MS = 200          // the engine writes a paste's file just after the placeholder lands
const PEEK_WAIT_TRIES = 10
const PEEK_SHRINK_MS = 8_000
const PEEK_API_MS = 8_000         // the transcript's image blocks: the one large read
const PEEK_READ_MAX = 4 * 1024 * 1024
const PEEK_CELL_SIDE = 800        // the side a picture is shrunk to before it is sampled into cells
const PEEK_DIR = 'ghostfleet-peek'
const PEEK_SITE = 'above-prompt'  // the requestId the band's slot is drawn under (measured), where the card is

let peekOn = false
let peekInteractive = false
let peekMode = 'cells'       // 'window' | 'kitty' | 'cells' (peek-shape.js previewMode): the latest decided
let peekEnv = {}             // the variables previewMode reads, as the session started
let peekRefused = ''         // why the engine drew a picture of ours as its alt: no Image draws here
let peekNoWindow = false     // the window program ended without showing: none opens here
let peekPlatform = ''
let peekTool = ''            // the shrinker that worked here
let peekSid = ''             // whose pictures these are: /clear starts the numbers again
let peekFolder = ''          // the session's temp folder, once found
let peekPoll = null
let peekFresh = true         // this copy of the module has not begun yet (peekBegin)
let peekDraftIds = []
let peekWin = null           // { target, isOpen }: the window program running now
let peekChanging = Promise.resolve()
const peekPixels = new Map() // N -> picture, kept small (thumb), for cells
const peekPngs = new Map()   // N -> base64 PNG of at most PNG_MAX, for a terminal through tmux or SSH
const peekLoading = new Set()
const peekPastes = new Map() // N -> { mediaType, base64 }: bytes a prompt handed over

async function peekSwitch($) {
  const dir = (await $.env.get('CLAUDE_FLEET_EXPERIMENTAL_DIR')) || `${await $.env.get('HOME')}/.config/ghostfleet`
  const text = await soon($, $.fs.read(`${dir}/peek.enabled`), '')
  return /^\s*on\s*$/.test(String(text))
}

// A state read's value, or `fallback` where there is none. (The read itself is written out at
// each call: `claude plugin validate` holds every $.state key to the contract only from a
// reference it can read there.)
const peekVal = (got, fallback) => (got && got.value !== undefined && got.value !== null ? got.value : fallback)

// Read the switch and make the session match it: on decides how pictures show here and starts
// looking at the box; off stops that, closes a window and forgets the pictures. Asked at the
// start and again at every turn's end, so `fleet-experimental disable peek` needs no restart.
async function peekSync($) {
  // A copy of the module that is asked before any session.start reached it: the engine replaced
  // the one that had (its hooks worker was lost), and this one learns where it runs on its own.
  if (peekFresh) await peekBegin($, ((await soon($, $.session.surfaces(), [])) || []).includes('terminal'))
  const on = await peekSwitch($)
  const was = peekOn
  peekOn = on
  if ((await peekVal(await soon($, $.state.get(PEEK_ON), null), null)) !== on) await soon($, $.state.set(PEEK_ON, on), null)
  if (on && !was) {
    const uname = await soon($, $.process.run(['uname', '-s'], { timeoutMs: IO_MS }), null)
    peekPlatform = platformOf(uname && uname.exitCode === 0 ? uname.stdout : '')
    // Each name written out: `claude plugin validate` lists what a module reads from literals.
    peekEnv = {
      TERM_PROGRAM: await $.env.get('TERM_PROGRAM'), TERM: await $.env.get('TERM'),
      KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'), TMUX: await $.env.get('TMUX'),
      TMUX_PANE: await $.env.get('TMUX_PANE'),
      SSH_CONNECTION: await $.env.get('SSH_CONNECTION'), SSH_TTY: await $.env.get('SSH_TTY'),
      CLAUDE_FLEET_PEEK: await $.env.get('CLAUDE_FLEET_PEEK'),
    }
    await peekDecide($)
    if (peekInteractive) {
      if (peekPoll) peekPoll.cancel()
      // A look that fails (the module unloading under it) waits for the next one.
      peekPoll = $.clock.every(PEEK_POLL_MS, () => {
        void $.prompt.read().then(box => peekTrack($, box.text)).catch(() => {})
      })
      const box = await soon($, $.prompt.read(), null)
      if (box) await peekTrack($, box.text)
    }
  }
  if (!on && was) await peekForget($)
  return on
}

// How the next preview shows (peekMode). Outside tmux the session's variables settle it. Inside,
// tmux names the terminal looking at this pane's window (peek-shape.js lookingClient): asked
// here, as a preview opens, because the session most likely started with no terminal attached
// and the one attached now may not be the one attached at the last hover. One client running
// two commands, so the window and the clients are read in the same breath. A tmux that does
// not answer is no terminal named: cells, where a Mac's window does not come first.
async function peekDecide($) {
  const opts = { platform: peekPlatform, env: peekEnv, isInteractive: peekInteractive && !peekNoWindow, refused: Boolean(peekRefused) }
  let client = null
  if (asksClient(opts)) {
    const sock = String(peekEnv.TMUX).split(',')[0]
    const pane = String(peekEnv.TMUX_PANE || '')
    const argv = ['tmux', '-u', '-S', sock, ...(pane ? ['display-message', '-p', '-t', pane, '#{window_id}', ';'] : []), 'list-clients', '-F', CLIENT_FORMAT]
    const r = await soon($, $.process.run(argv, { timeoutMs: IO_MS }), null)
    const out = r && r.exitCode === 0 ? String(r.stdout) : ''
    const cut = pane ? out.indexOf('\n') : -1
    client = lookingClient(out.slice(cut + 1), cut >= 0 ? out.slice(0, cut).trim() : '')
  }
  peekMode = previewMode({ ...opts, client })
  return peekMode
}

// A RELOAD KEEPS $.state AND STARTS THE MODULE OVER, and the pictures were in both. PEEK_PICS
// says which pastes were read; the pixels a card is drawn from, the bytes a prompt handed over
// and the window a hover opened lived in the module, and went with it. So a paste read before
// /reload-plugins was still "read" after it, never read again, and its card said loading for as
// long as the session ran; the new code never saw the file, and wrote nothing beside it. The
// same for a paste an older mod read and recorded in its own shape, which is what a reload
// after a deploy meets. A new copy of the module starts its pictures again: each paste in the
// box, or in a sent prompt, is read on the next look, by this code.
//   The look itself was never the fault, though it was the first suspect: measured on 2.1.319,
// a reload's session.start says isInteractive like the first one, the new copy arms its poll on
// the switch's edge, and only that poll ticks (the engine drops the old copy's timers). One
// copy would miss it: one the engine starts in place of a lost hooks worker, whose first event
// can be a turn's end with no session.start before it, so it never learns it is in a terminal
// and never looks. It asks the session instead.
async function peekBegin($, interactive) {
  peekFresh = false
  peekInteractive = interactive
  await soon($, $.state.set(PEEK_PICS, {}), null)
  await soon($, $.state.set(PEEK_SHOWN, null), null)
}

async function peekForget($) {
  if (peekPoll) { peekPoll.cancel(); peekPoll = null }
  peekCloseWindow()
  peekPixels.clear(); peekPngs.clear(); peekPastes.clear(); peekDraftIds = []; peekFolder = ''
  await soon($, $.state.set(PEEK_DRAFT, []), null)
  await soon($, $.state.set(PEEK_PICS, {}), null)
  await soon($, $.state.set(PEEK_SHOWN, null), null)
}

// After /clear the numbers start again from 1: what was read belongs to the session before.
async function peekFollow($) {
  const sid = await soon($, $.session.id(), '')
  if (sid === peekSid) return
  const had = peekSid !== ''
  peekSid = sid
  peekFolder = ''
  peekPixels.clear(); peekPngs.clear(); peekPastes.clear()
  if (had) {
    await soon($, $.state.set(PEEK_PICS, {}), null)
    await peekChange($, () => null)
  }
}

// ── finding a paste ──

// The session's temp folder (peek-shape.js sessionDirs): the one holding `images`, else the
// first candidate, which is where PEEK's own folder goes even before Claude Code made one.
async function peekSessionFolder($) {
  if (peekFolder) return peekFolder
  const out = await soon($, $.process.run(['id', '-u'], { timeoutMs: IO_MS }), null)
  const uid = out && out.exitCode === 0 ? String(out.stdout).trim() : ''
  const tmp = (await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp'
  const dirs = sessionDirs({ tmp, uid, root: await soon($, $.session.root(), ''), cwd: await soon($, $.session.cwd(), ''), sessionId: peekSid })
  for (const d of dirs) {
    if (await soon($, $.fs.list(`${d}/images`), null)) return (peekFolder = d)
  }
  // A project path too long for one folder name has a hash after it: look for the session.
  if (dirs.length) {
    const base = dirs[0].slice(0, dirs[0].lastIndexOf('/', dirs[0].lastIndexOf('/') - 1))
    for (const entry of (await soon($, $.fs.list(base), null)) || []) {
      if (entry.kind !== 'dir') continue
      const d = `${base}/${entry.name}/${peekSid}`
      if (await soon($, $.fs.list(`${d}/images`), null)) return (peekFolder = d)
    }
  }
  return dirs[0] || ''
}

// Paste N as a file: { file, size } or { why }. Claude Code's copy first; else the prompt's or
// the transcript's bytes, written once into PEEK's folder.
async function peekFile($, n) {
  const folder = await peekSessionFolder($)
  if (!folder) return { why: WHY.noBytes }
  const names = ((await soon($, $.fs.list(`${folder}/images`), null)) || []).map(x => x.name)
  const name = storedImage(names, n)
  if (name) {
    const file = `${folder}/images/${name}`
    const st = await soon($, $.fs.stat(file), null)
    if (st && st.isLink) return { why: WHY.link }
    if (st && st.kind === 'file') return { file, size: st.size }
  }
  const mine = `${folder}/${PEEK_DIR}`
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    const st = await soon($, $.fs.stat(`${mine}/${n}.${ext}`), null)
    if (st && st.kind === 'file' && !st.isLink) return { file: `${mine}/${n}.${ext}`, size: st.size }
  }
  if (!peekPastes.has(n)) {
    const full = await soon($, $.session.messages({ as: 'api' }), [], PEEK_API_MS)
    for (const [k, img] of pastesFromApi(Array.isArray(full) ? full : [])) if (!peekPastes.has(k)) peekPastes.set(k, img)
  }
  const img = peekPastes.get(n)
  if (!img) return { why: WHY.noBytes }
  const kind = sniff(fromBase64(img.base64.slice(0, 64 * 1024)))
  if (!kind) return { why: WHY.notImage }
  const file = `${mine}/${n}.${EXT[kind.format]}`
  // The bytes ride on stdin and the path as $1: neither is ever inside the script's text.
  const wrote = await soon($, $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'peek', file],
    { stdin: img.base64, timeoutMs: PEEK_SHRINK_MS }), null, PEEK_SHRINK_MS + 1000)
  if (!wrote || wrote.exitCode !== 0) return { why: WHY.failed }
  return { file, size: Math.floor(img.base64.length * 3 / 4) }
}

// The first shrinker that works here, remembered: `file` as a PNG at `out`, at most `side`.
async function peekShrink($, file, out, side) {
  const tools = peekTool ? [peekTool] : SHRINKERS[peekPlatform] || SHRINKERS.other
  await soon($, $.process.run(['mkdir', '-p', out.slice(0, out.lastIndexOf('/'))], { timeoutMs: IO_MS }), null)
  for (const tool of tools) {
    const r = await soon($, $.process.run(shrinkArgv(tool, file, out, side), { timeoutMs: PEEK_SHRINK_MS }), null, PEEK_SHRINK_MS + 1000)
    if (r && r.exitCode === 0) { peekTool = tool; return true }
  }
  return false
}

// Whether paste N is ready to show the way `mode` shows it: a window needs only the file; the
// terminal its PNG (as bytes, where it goes as bytes) or, where none could be had, the cells it
// fell back to; cells their pixels.
function peekHas(pic, n, mode) {
  if (!pic || !pic.ready) return false
  if (mode === 'window') return true
  if (mode === 'cells') return peekPixels.has(n)
  return pic.png ? !sendsBytes(peekEnv) || peekPngs.has(n) : pic.drawn === 'kitty' && peekPixels.has(n)
}

// Reads paste N into PEEK_PICS: its file, kind and size, and for the terminal what it draws (a
// PNG for kitty, pixels for cells). A window needs only the file. Once for each way it is shown:
// inside tmux the next preview can be another terminal's, or cells after the engine refused.
async function peekLoad($, n) {
  if (!peekOn || peekLoading.has(n)) return
  const pics = await peekVal(await soon($, $.state.get(PEEK_PICS), null), {})
  const had = pics[n]
  if (had && (had.why ? !had.retry : peekHas(had, n, peekMode))) return
  peekLoading.add(n)
  const sid = peekSid
  const mode = peekMode
  let pic
  try {
    let got = await peekFile($, n)
    for (let i = 0; got.why === WHY.noBytes && i < PEEK_WAIT_TRIES; i++) {
      await $.clock.sleep(PEEK_WAIT_MS)
      got = await peekFile($, n)
    }
    pic = got.why ? { label: `[Image #${n}]`, why: got.why, retry: got.why === WHY.noBytes } : await peekRead($, n, got.file, got.size, mode)
  } catch {
    pic = { label: `[Image #${n}]`, why: WHY.failed, retry: true }
  } finally {
    peekLoading.delete(n)
  }
  if (!peekOn || sid !== peekSid) return
  const now = await peekVal(await soon($, $.state.get(PEEK_PICS), null), {})
  await soon($, $.state.set(PEEK_PICS, { ...now, [n]: pic }), null)
  // The way it shows changed while this one read it (a hover through another terminal, or the
  // engine refusing): read it again for that. Each read settles peekHas for its own mode, so
  // this ends when the mode stops changing.
  if (peekMode !== mode && !pic.why && !peekHas(pic, n, peekMode)) void peekLoad($, n)
}

// Paste N as PNG bytes for a terminal that draws through tmux or SSH: at most PNG_MAX decoded
// (the engine refuses more) and at most KITTY_SIDE on its long side, a PNG already that small
// as it is. A larger one is shrunk, side by side, till it fits. { png, base64 } or null.
async function peekKittyBytes($, n, file, kind, size, b64, cache) {
  const long = Math.max(kind.width || 0, kind.height || 0)
  if (kind.format === 'png' && b64 && size <= PNG_MAX && long && long <= KITTY_SIDE) return { png: file, base64: b64 }
  const out = `${cache}/${n}.kitty.png`
  for (const side of kittySides(kind.width, kind.height)) {
    if (!(await peekShrink($, file, out, side))) return null
    const got = await soon($, $.fs.read(out, { as: 'bytes' }), null)
    if (got && got.base64 && decodedSize(got.base64) <= PNG_MAX) return { png: out, base64: got.base64 }
  }
  return null
}

async function peekRead($, n, file, size, mode) {
  const label = `[Image #${n}]`
  let bytes = null, b64 = ''
  if (size <= PEEK_READ_MAX) {
    const got = await soon($, $.fs.read(file, { as: 'bytes' }), null)
    b64 = got && got.base64 ? got.base64 : ''
    bytes = b64 ? fromBase64(b64) : null
  } else {
    const head = await soon($, $.process.run(['/bin/sh', '-c', 'head -c 65536 "$1" | base64', 'peek', file], { timeoutMs: IO_MS }), null)
    bytes = head && head.exitCode === 0 ? fromBase64(head.stdout) : null
  }
  const kind = bytes && sniff(bytes)
  if (!kind) return { label, why: bytes ? WHY.notImage : WHY.missing, retry: !bytes }
  const base = { label, file, format: kind.format, bytes: size, width: kind.width, height: kind.height, drawn: mode }
  if (mode === 'window') return { ...base, ready: true }
  const larger = !kind.width || Math.max(kind.width, kind.height) > PEEK_CELL_SIDE
  const cache = `${file.slice(0, file.lastIndexOf('/images/') >= 0 ? file.lastIndexOf('/images/') : file.lastIndexOf('/'))}/${PEEK_DIR}`
  if (mode === 'kitty' && sendsBytes(peekEnv)) {
    // Bytes, or cells where none fit: never a file name the terminal over there cannot open.
    const got = await peekKittyBytes($, n, file, kind, size, b64, cache)
    if (got) { peekPngs.set(n, got.base64); return { ...base, png: got.png, ready: true } }
  } else if (mode === 'kitty') {
    // The terminal Claude Code writes to directly, on this machine: it reads the file itself.
    if (kind.format === 'png') return { ...base, png: file, ready: true }
    const out = `${cache}/${n}.view.png`
    return (await peekShrink($, file, out)) ? { ...base, png: out, ready: true } : { ...base, why: WHY.noDecoder }
  }
  // Cells: a PNG small enough decodes here; anything else is shrunk to one first.
  let pixels = kind.format === 'png' && bytes.length === size && !larger ? decodePng(bytes) : null
  if (!pixels) {
    const out = `${cache}/${n}.cells.png`
    if (await peekShrink($, file, out, larger ? PEEK_CELL_SIDE : undefined)) {
      const got = await soon($, $.fs.read(out, { as: 'bytes' }), null)
      pixels = got && got.base64 ? decodePng(fromBase64(got.base64)) : null
    }
  }
  if (!pixels) {
    const ff = await soon($, $.process.run(ffmpegFileArgv(file), { timeoutMs: PEEK_SHRINK_MS }), null, PEEK_SHRINK_MS + 1000)
    if (ff && ff.exitCode === NO_FFMPEG) return { ...base, why: WHY.noDecoder }
    pixels = ff && ff.exitCode === 0 && !ff.isStdoutTruncated ? parsePam(fromBase64(ff.stdout)) : null
  }
  if (!pixels) return { ...base, why: WHY.failed }
  peekPixels.set(n, thumb(pixels))
  return { ...base, width: kind.width || pixels.width, height: kind.height || pixels.height, ready: true }
}

// ── the draft, the preview ──

// Keeps the row above the prompt in step with the box.
async function peekTrack($, text) {
  if (!peekOn) return
  await peekFollow($)
  const ids = pastesIn(text)
  if (!sameIds(ids, peekDraftIds)) {
    peekDraftIds = ids
    await soon($, $.state.set(PEEK_DRAFT, ids), null)
    await peekChange($, peekCloseChip)
  }
  for (const n of ids) void peekLoad($, n)
}

// A preview the row above the prompt opened (`.../chip:N`) closes when the box changes: the
// box may grow and move the chip from under the pointer, which would then say nothing.
const peekCloseChip = now => (now && /\/chip:\d+$/.test(now.target) ? null : now)

// Opens, moves or closes (null) the preview, one change at a time, each handed the one before:
// leaving one chip and entering the next are two changes that can arrive in either order.
function peekChange($, next) {
  const run = peekChanging.then(async () => {
    const last = await peekVal(await soon($, $.state.get(PEEK_SHOWN), null), null)
    const to = next(last)
    if (last === to || (last && to && last.n === to.n && last.target === to.target && last.edge === to.edge && last.mode === to.mode)) return
    await soon($, $.state.set(PEEK_SHOWN, to), null)
    if (to && to.edge === 'window') void peekOpenWindow($, to.n, to.target)
    else peekCloseWindow()
  })
  peekChanging = run.catch(() => {})
  return run
}

const peekPlace = (n, target) => ({ n, target, edge: peekMode === 'window' ? 'window' : 'card', mode: peekMode })

// The window by the pointer, till peekCloseWindow. The program ticks ten times a second, so
// the loop wakes to find it closed, and leaving the loop ends the program (./peek-window.js).
// One that ends without having said `shown` cannot show a window here: cells from now on.
async function peekOpenWindow($, n, target) {
  if (peekWin && peekWin.target === target && peekWin.isOpen) return
  peekCloseWindow()
  const me = { target, isOpen: true }
  peekWin = me
  await peekLoad($, n)
  const pic = (await peekVal(await soon($, $.state.get(PEEK_PICS), null), {}))[n]
  if (!pic || !pic.file || !me.isOpen) { if (peekWin === me) peekWin = null; return }
  let shown = false, said = ''
  try {
    const child = $.process.spawn({ argv: ['osascript', '-l', 'JavaScript', '-e', PEEK_WINDOW],
      env: { PEEK_FILE: pic.file, PEEK_SIZE: String(WINDOW.size), PEEK_LIFE: String(WINDOW.life) } })
    for await (const piece of child) {
      if (said.length < 2000 && piece.text) said += piece.text
      if (/^shown$/m.test(piece.text || '')) shown = true
      if (!me.isOpen) break
    }
  } catch (err) {
    said += String(err && err.message ? err.message : err)
  }
  if (peekWin === me) peekWin = null
  if (shown || !me.isOpen) return
  void $.ui.log(`ghostfleet peek: no window (${said.replace(/\.\n/g, '').trim().slice(0, 300) || 'osascript did not start'}); a card from now on`, { to: 'debug' })
  peekNoWindow = true
  await peekDecide($)
  peekPixels.delete(n)
  const pics = await peekVal(await soon($, $.state.get(PEEK_PICS), null), {})
  const { [n]: _gone, ...rest } = pics
  await soon($, $.state.set(PEEK_PICS, rest), null)
  void peekLoad($, n)
  await peekChange($, now => (now && now.edge === 'window' ? null : now))
}

function peekCloseWindow() {
  if (peekWin) peekWin.isOpen = false
  peekWin = null
}

async function peekOpenImage($, n) {
  await peekLoad($, n)
  const pic = (await peekVal(await soon($, $.state.get(PEEK_PICS), null), {}))[n]
  if (!pic || !pic.file) return
  await soon($, $.process.run(openArgv(peekPlatform, pic.file), { timeoutMs: IO_MS }), null)
}

// ── the hooks ──

async function peekStart($, e) {
  if (peekFresh) await peekBegin($, Boolean(e && e.isInteractive))
  else peekInteractive = Boolean(e && e.isInteractive)
  await peekFollow($)
  await peekSync($)
}

// From onTurnComplete, the main loop's end: the switch again.
async function peekTurnComplete($) {
  await peekSync($)
}

function peekEnd() {
  if (peekPoll) { peekPoll.cancel(); peekPoll = null }
  peekCloseWindow()
}

// From onPromptSubmit, before `next`: the prompt's own pastes, while the engine still hands
// their bytes over. After this hook they are only in the transcript, the expensive place.
async function peekPrompt($, e) {
  if (!peekOn || !Array.isArray(e.attachments) || !e.attachments.length) return
  const images = e.attachments.filter(a => a && a.type === 'image' && a.id)
  for (const { n, image } of pairPastes(pastesIn(e.text), images)) {
    let base64 = '', offset, mediaType = image.mediaType || ''
    for (let i = 0; i < 8; i++) {
      const m = await soon($, $.prompt.media({ id: image.id, ...(offset !== undefined ? { offset } : {}) }), null)
      if (!m || !m.base64) break
      base64 += m.base64; mediaType = m.mediaType || mediaType
      if (m.next === undefined) { peekPastes.set(n, { mediaType, base64 }); break }
      offset = m.next
    }
  }
}

// From onPromptSubmit, after `next`: the draft is gone, and so are its chips and preview.
async function peekSubmitted($, e) {
  if (!peekOn || !e.origin || e.origin.kind !== 'composer') return
  peekDraftIds = []
  await soon($, $.state.set(PEEK_DRAFT, []), null)
  await peekChange($, () => null)
  for (const n of pastesIn(e.text)) void peekLoad($, n)
}

async function onPeekEdit($, e, next) {
  const box = await next(e)
  if (!peekOn) return box
  await peekChange($, peekCloseChip)
  await peekTrack($, box.text)
  return box
}

async function onPeekMessage($, e, next) {
  const result = await next(e)
  if (!peekOn) return result
  const chip = chipOf(e.element)
  if (!chip) return result
  const target = `${e.requestId}/${e.element}`
  const data = e.data && typeof e.data === 'object' ? e.data : {}
  if (data.isClicked === true) {
    // The viewer opens over where a preview would stand: close it first.
    await peekChange($, () => null)
    void peekOpenImage($, chip.n)
    return result
  }
  const isOver = data.isOver === true
  const was = isOver ? await peekVal(await soon($, $.state.get(PEEK_SHOWN), null), null) : null
  if (isOver) void peekLoad($, chip.n)
  await peekChange($, now => (!isOver ? (now && now.target === target ? null : now)
    : now && now.target === target ? now : peekPlace(chip.n, target)))
  // A pointer moving on a chip posts on every cell: a new preview is asked about, a moved one
  // not. Off this hook, so a leave that comes while tmux answers is not put behind the enter.
  // One the module unloading under it aborts is no answer: the next preview asks again.
  if (isOver && (!was || was.target !== target)) void peekAsk($, chip.n, target).catch(() => {})
  return result
}

// The preview just opened at `target` shows the way the terminal looking now draws it: opened the
// way the last one was (peekMode), and changed if tmux names another terminal now.
async function peekAsk($, n, target) {
  const before = peekMode
  await peekDecide($)
  if (peekMode !== before) {
    void peekLoad($, n)
    await peekChange($, cur => (cur && cur.target === target ? peekPlace(cur.n, cur.target) : cur))
  }
  if (peekMode === 'kitty') await peekVerify($, n, target)
}

// Whether the engine drew the picture a card holds, or its alt. It answers that only for an
// Image it has mounted, so the card is looked for for a second after it opens; a blit of the
// source it already has sends nothing to the terminal. Its alt is drawn where it decided, when
// it started, that the terminal draws no pictures, and it does not ask again (measured on
// 2.1.319: nor when a terminal attaches later, nor on a focus-in), so from then on this session
// shows cells, and says why under them. Never the alt alone where cells would draw.
async function peekVerify($, n, target) {
  for (let i = 0; i < 20; i++) {
    await $.clock.sleep(50)
    const now = await peekVal(await soon($, $.state.get(PEEK_SHOWN), null), null)
    if (!now || now.target !== target || now.mode !== 'kitty') return
    const pic = (await peekVal(await soon($, $.state.get(PEEK_PICS), null), {}))[n]
    if (!pic || !pic.ready) continue
    const source = pic.png && imageSource(peekEnv, pic.png, peekPngs.get(n))
    if (!source) return // cells already: no PNG could be had
    const r = await soon($, $.ui.blit({ requestId: PEEK_SITE, key: `image-${n}`, source }), null)
    if (!r || !r.deny) return
    if (!drawsAlt(r)) continue // not mounted yet
    peekRefused = refusalNote(r)
    void $.ui.log(`ghostfleet peek: the engine draws pictures as their alt here (${r.deny.slice(0, 300)}); cells from now on`, { to: 'debug' })
    await peekDecide($)
    void peekLoad($, n)
    await peekChange($, cur => (cur && cur.mode === 'kitty' ? peekPlace(cur.n, cur.target) : cur))
    return
  }
}

// The fullscreen layout is the one that reports the pointer.
const peekPointer = e => e.surface === 'terminal' && !(e.viewport && e.viewport.isFullscreen === false)

// The card, in the terminal: the picture in a round border, its caption under it, every line
// written to the card's full width so the transcript under it does not show through.
function peekCard(ui, pic, n, cols, rows, mode) {
  const { Box, Text, Raster, Image } = ui
  const label = `[Image #${n}]`
  const line = (t, w) => h(Text, { dimColor: true, wrap: 'truncate-end' }, t.padEnd(w))
  // { card, rows }: the element, and how many rows it takes (border and caption included).
  const frame = (w, inner, ...kids) => ({ rows: inner + 2 + kids.length - 1,
    card: h(Box, { key: `card-${n}`, flexDirection: 'column', borderStyle: 'round', borderDimColor: true, flexShrink: 0, width: w + 2 }, ...kids) })
  if (!pic || (!pic.ready && !pic.why)) return frame(cols, 1, line(`${label} loading…`, cols))
  if (pic.why) return frame(cols, 1, line(`${label} no preview: ${pic.why}`, cols))
  const cap = caption({ label }, { width: pic.width, height: pic.height, format: pic.format, size: pic.bytes })
  let inner = null, w = 0, hgt = 0
  // Shrunk to fit, never enlarged: a picture smaller than the room is drawn at its own size.
  if (pic.width && pic.height) { cols = Math.min(cols, pic.width); rows = Math.min(rows, Math.ceil(pic.height / 2)) }
  // The terminal's own picture only while this preview is one (`mode`), and only from a source
  // it can draw: bytes through tmux or SSH, never a file name there (peek-shape.js imageSource).
  const source = mode === 'kitty' && pic.png ? imageSource(peekEnv, pic.png, peekPngs.get(n)) : null
  if (source && Image) {
    const fit = fitCells(pic.width || 1, pic.height || 1, cols, rows)
    w = fit.cols; hgt = fit.rows
    inner = h(Image, { key: `image-${n}`, source, columns: w, rows: hgt, alt: label })
  } else if (peekPixels.has(n) && Raster) {
    const r = rasterOf(peekPixels.get(n), cols, rows)
    if (r) { w = r.cols; hgt = r.rows; inner = h(Raster, { key: `image-${n}`, columns: w, rows: hgt, cells: r.cells }) }
  }
  if (!inner) return frame(cols, 1, line(`${label} loading…`, cols))
  // Cells where the terminal would have drawn it, had the engine let it: said under the caption.
  const why = source || !peekRefused ? '' : `cells: ${peekRefused}`
  const width = Math.max(w, Math.min(Math.max(cap.length, why.length), cols))
  const left = Math.floor((width - w) / 2), right = width - w - left
  const side = (k, m) => m > 0 ? [h(Text, { key: k }, Array.from({ length: hgt }, () => ' '.repeat(m)).join('\n'))] : []
  return frame(width, hgt + 1 + (why ? 1 : 0), h(Box, { key: 'pic', flexDirection: 'row' }, ...side('l', left), inner, ...side('r', right)), line(cap, width),
    ...(why ? [h(Text, { key: 'why', dimColor: true, wrap: 'truncate-end' }, why.padEnd(width))] : []))
}

// Above the prompt: the card a hover opened, over a chip each for the draft's pastes. The card
// is drawn here whichever target opened it, a chip of this row or an `[Image #N]` of a sent
// prompt, because this is the one place in the terminal it lays out (see onPeekSent). Called
// from the band's AbovePrompt hook, beneath its rows; what is beneath it is drawn after.
async function onPeekBand($, e, next) {
  if (e.props.hasSurvey || !peekPointer(e) || !(await peekVal(await soon($, $.state.get(PEEK_ON), null), false))) return next(e)
  const ids = await peekVal(await soon($, $.state.get(PEEK_DRAFT), null), [])
  const now = await peekVal(await soon($, $.state.get(PEEK_SHOWN), null), null)
  const showing = Boolean(now && now.edge === 'card')
  const below = await next(e)
  if (!ids.length && !showing) return below
  const ui = $.ui.resolve(e)
  const { Box, Text, Client } = ui
  const cols = Math.max(12, Math.min(96, e.props.bodyColumns - 2))
  // In the flow: the slot is a window of at most `maxRows` that clips what is floated out of
  // it (measured: a card at `bottom: 1` was in the tree and never on the screen). So the card
  // takes the slot's rows while it shows, less the chips' row, its own border and caption, and
  // room for the band's rows above it.
  const rows = Math.max(3, Math.min(24, (e.props.maxRows || 12) - 8))
  const pics = showing ? peekVal(await soon($, $.state.get(PEEK_PICS), null), {}) : {}
  return h(Box, { flexDirection: 'column' },
    ...(showing ? [peekCard(ui, pics[now.n], now.n, cols, rows, now.mode || peekMode).card] : []),
    ...(ids.length ? [h(Box, { key: 'peek-chips', flexDirection: 'row', columnGap: 1 },
      ...ids.map(n => h(Client, { key: `chip:${n}`, module: './peek-chip.js', props: { label: `[Image #${n}]` } })),
      h(Text, { key: 'hint', dimColor: true }, 'hover to preview · click to open'))] : []),
    ...(below ? [below] : []))
}

// A sent prompt: an unpainted chip over each `[Image #N]` of its first line and over each row
// Claude Code lists its images in. Targets only: a card floated from here was drawn under the
// rows the transcript lays out after it, and clamped to the screen's top (measured), so the
// card a hover here opens is drawn above the prompt (onPeekBand), or is the window.
async function onPeekSent($, e, next) {
  if (!peekPointer(e) || !e.props.origin || e.props.origin.kind !== 'composer') return next(e)
  const ns = pastesIn(e.props.text)
  if (!ns.length || !(await peekVal(await soon($, $.state.get(PEEK_ON), null), false))) return next(e)
  const pics = peekVal(await soon($, $.state.get(PEEK_PICS), null), {})
  for (const n of ns) if (!pics[n]) void peekLoad($, n)
  const drawn = await next(e)
  const has = n => Boolean(pics[n] && !pics[n].why)
  const { Box, Client } = $.ui.resolve(e)
  const over = []
  for (const t of listedTargets(ns, has)) {
    over.push(h(Box, { key: `listed-${t.n}`, position: 'absolute', bottom: t.bottom, left: t.left },
      h(Client, { key: `sent:${t.n}`, module: './peek-chip.js', width: t.width, height: 1 })))
  }
  for (const t of tokenTargets(e.props.text, e.viewport && e.viewport.columns, has)) {
    over.push(h(Box, { key: `token-${t.n}`, position: 'absolute', top: 1, left: t.left },
      h(Client, { key: `token:${t.n}`, module: './peek-chip.js', width: t.width, height: 1 })))
  }
  if (!over.length) return drawn
  return h(Box, { flexDirection: 'column' }, drawn, ...over)
}
