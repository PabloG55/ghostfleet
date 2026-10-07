// ghostfleet's mod: the fleet's view of a Claude session, from inside the session.
//
// Everything the fleet knew about a Claude session it learned from OUTSIDE: a regex over
// the captured pane for "is it working" (blind at 56 columns, fooled by a leftover login
// line, by prose that quotes a spinner), the status bar scraped for the 5h budget (gone
// below ~100 columns, frozen on an idle pane), and a lead spending a whole turn to run
// fleet-inbox through Bash. From in here there is nothing to guess: a turn starts, a turn
// completes, a dialog is about to be drawn, the engine measures the account.
//
// Five things, each a section below, all sharing the record I/O at the top:
//   STATE     written into the session's status record as it changes
//   BUDGET    the account's rate-limit windows, from the engine's own measurement
//   COMMANDS  /fleet and /inbox, answered without a turn
//   GUARDS    the fleet's refusals in front of Bash and the MCP tools, failing CLOSED
//   BAND      a lead's team above its prompt
// What is written is shaped by ./shape.js, ./guard-shape.js and ./band-shape.js, plain
// functions the suite can run with node. The engine follows `$` only into functions declared
// in this file, never across an import, which is why the hooks are one file and not five.
//
// THE OBSERVERS DECIDE NOTHING, THE GUARDS DECIDE AND FAIL CLOSED. STATE, BUDGET, COMMANDS
// and BAND only observe: a hook of theirs that throws or runs out of time is skipped and the
// session goes on as if this were not loaded, which is exactly right for an observer, so none
// carries a `.catch` that could refuse in its place. GUARDS is the one section whose hooks
// refuse, and each is registered with a `.catch` that refuses too (that section says why).
// Nothing here touches the network or a model. Every file and process call is bounded
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
  startBand($)
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
  // GUARDS and BAND, below the wiring so each is one section of its own.
  on('tool.call', { tool: 'Bash' }, onBash).catch(bashFailedClosed)
  on('tool.call', { tool: /^mcp__/ }, onMcp).catch(mcpFailedClosed)
  on('ui.render', { component: 'AbovePrompt' }, onBandRender)
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

async function onBandRender($, e, next) {
  if (e.props.hasSurvey) return next(e)
  const { value } = await $.state.get(BAND)
  const runs = value ? bandRuns(value, value.prs, e.props.bodyColumns) : null
  if (!runs) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  return (
    h(Box, { flexDirection: 'row' },
      ...runs.map((r, i) => h(Text, {
        key: String(i), wrap: 'truncate-end',
        ...(r.color ? { color: r.color } : {}), ...(r.dim ? { dimColor: true } : {}), ...(r.bold ? { bold: true } : {}),
      }, r.text)))
  )
}

// Started from onSessionStart (one session.start hook per module), after the record exists.
function startBand($) {
  if (bandTick) bandTick.cancel()
  if (prTick) prTick.cancel()
  refresh($).catch(() => {})
  bandTick = $.clock.every(BAND_TICK_MS, () => { refresh($).catch(() => {}) })
  prTick = $.clock.every(BAND_PR_MS, () => { refreshPrs($).catch(() => {}) })
}
