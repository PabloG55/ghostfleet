// What the guards decide from, as plain functions of strings: no `$`, no I/O.
//
// Kept apart from guards.js for the reason shape.js is: test/run.sh imports this file with
// node and holds it to the shell guard it stands in for (hooks/fleet-guard.sh), command for
// command, so the two cannot drift into two answers to "is this a merge".

// ── the merge guard's patterns, from hooks/fleet-guard.sh ───────────────────
//
// The shell's POSIX classes spelled out. Whitespace is folded first, as `tr '\n\t' '  '`
// folds it there, so a merge split across lines is still one.
const fold = cmd => String(cmd || '').replace(/[\n\t]/g, ' ')

// ── what a command RUNS, as opposed to what it says ─────────────────────────
//
// The patterns below are words, and a worker's own messages are made of the same words. A
// brief about merging invites the acknowledgement "I push, the lead runs gh pr merge", and
// the guard read that quoted sentence as a merge: the fleet-ack the contract requires was
// refused twice before a reworded third got through. Nothing in the sentence runs. So the
// patterns are matched against this instead — the command with the ARGUMENTS of a messaging
// command (fleet-ack, fleet-send, fleet-ledger, git commit) taken out, since those reach a
// file or another session's input box and never a shell.
//
// Only a simple command whose command word IS one of those, bare and at the start, is
// trimmed; everything else is passed through verbatim. And it fails toward the old answer:
//   - a `$(`, a backtick, `<(` or `>(` anywhere in that command keeps the whole of it — the
//     shell runs those even inside double quotes, which is how a merge would be smuggled
//   - an unterminated quote or a trailing backslash returns the command unchanged
//   - `; & | ( )` and a NEWLINE end a simple command, so a merge chained after a message is
//     its own command and is judged. This runs BEFORE whitespace is folded: folded, the
//     newline between `fleet-ack x` and `gh pr merge 5` would vanish and make the merge an
//     argument of the ack.
// A misreading in the cautious direction (a `(` taken for an operator, a `{` for a word)
// only keeps text that is then judged as before. hooks/fleet-guard.sh what_runs is the same
// scan in awk, and test/run.sh holds the two to one answer.
const MESSAGING = new Set(['fleet-ack', 'fleet-send', 'fleet-ledger'])
const SUBST = /\$\(|`|[<>]\(/

// the leading NAME=value words are assignments, not the command
const commandAt = words => {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  return i
}
// `git [-C dir] [-c k=v] [--opt] commit …`: the first word that is not an option or an
// option's value has to be `commit`
function gitCommits(words, i) {
  for (let j = i + 1; j < words.length; j++) {
    if (words[j] === '-C' || words[j] === '-c') { j++; continue }
    if (words[j].startsWith('-')) continue
    return words[j] === 'commit'
  }
  return false
}
function trimmed(seg) {
  if (SUBST.test(seg.raw)) return seg.raw
  const i = commandAt(seg.words)
  const w = seg.words[i]
  if (MESSAGING.has(w)) return ` ${w} `
  if (w === 'git' && gitCommits(seg.words, i)) return ' git commit '
  return seg.raw
}

export function whatRuns(cmd) {
  const s = String(cmd || '')
  let out = ''
  let seg = { raw: '', words: [] }
  let cur = null
  const endWord = () => { if (cur !== null) seg.words.push(cur); cur = null }
  const endSeg = op => { endWord(); out += trimmed(seg) + op; seg = { raw: '', words: [] } }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      const ansi = c === '$'
      let j = ansi ? i + 2 : i + 1
      let t = ''
      for (; j < s.length && s[j] !== "'"; j++) {
        if (ansi && s[j] === '\\' && j + 1 < s.length) j++
        t += s[j]
      }
      if (j >= s.length) return s
      seg.raw += s.slice(i, j + 1); cur = (cur ?? '') + t; i = j; continue
    }
    if (c === '"') {
      let j = i + 1
      let t = ''
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) j++
        t += s[j]
      }
      if (j >= s.length) return s
      seg.raw += s.slice(i, j + 1); cur = (cur ?? '') + t; i = j; continue
    }
    if (c === '\\') {
      if (i + 1 >= s.length) return s
      seg.raw += s.slice(i, i + 2)
      if (s[i + 1] !== '\n') cur = (cur ?? '') + s[i + 1]
      i++; continue
    }
    if ((c === '$' || c === '<' || c === '>') && s[i + 1] === '(') {
      seg.raw += s.slice(i, i + 2); cur = (cur ?? '') + s.slice(i, i + 2); i++; continue
    }
    if (';&|()\n'.includes(c)) { endSeg(c); continue }
    seg.raw += c
    if (c === ' ' || c === '\t') { endWord(); continue }
    cur = (cur ?? '') + c
  }
  endSeg('')
  return out
}

const MERGES = [
  // `gh pr merge`, with --auto too: that is a merge scheduled for later
  /(^|[^A-Za-z0-9_.-])gh\s([^|;&]*\s)?pr\s+merge(\s|$)/,
  // the REST endpoint, which is what a model reaches for when the porcelain is refused
  /(^|[^A-Za-z0-9_.-])gh\s([^|;&]*\s)?api\s[^|;&]*pulls\/[^\s/]+\/merge/,
  /mergePullRequest|enablePullRequestAutoMerge/,
]
export const mergesAPr = cmd => MERGES.some(re => re.test(fold(whatRuns(cmd))))

const BOUNDARY_WRITES = [
  /(^|[^A-Za-z0-9_.-])fleet-project\s+set(\s|$)/,
  /\.(workers-merge|agents-approve)(-off)?([^A-Za-z0-9_-]|$)/,
]
export const changesABoundary = cmd => BOUNDARY_WRITES.some(re => re.test(fold(whatRuns(cmd))))

// The MCP tools the merge guard stands in front of: any server's merge_pull_request.
export const isMergeTool = tool => /^mcp__.+__merge_pull_request$/.test(String(tool || ''))

// Which PR a merge command names: a REST call carries it in the path; `gh pr merge` takes
// it as the first bare word after `merge`, and with none it means the current branch's PR.
// `repo` is a -R/--repo, when given.
export function prSelector(cmd) {
  const flat = fold(cmd)
  let sel = (flat.match(/pulls\/([0-9]+)\/merge/) || [])[1] || ''
  if (!sel) {
    const w = flat.split(/\s+/).filter(Boolean)
    for (let i = 1; i < w.length - 1 && !sel; i++) {
      if (w[i] !== 'merge' || w[i - 1] !== 'pr') continue
      for (let j = i + 1; j < w.length; j++) {
        if (/^[;&|]/.test(w[j])) break
        if (!w[j].startsWith('-')) { sel = w[j]; break }
      }
      break
    }
  }
  const repo = (flat.match(/.*(?:-R|--repo)[ =]([^ ]+)/) || [])[1] || ''
  return { sel, repo }
}

// "Workers can merge" / "agents can approve tool calls" (lib/boundary.sh): most specific
// wins. `has(name)` says whether a marker of that name is in the fleet dir.
export function boundaryOn(setting, sock, sess, has) {
  if (!setting || !sock) return false
  if (sess) {
    if (has(`${sock}.${sess}.${setting}-off`)) return false
    if (has(`${sock}.${sess}.${setting}`)) return true
  }
  return has(`${sock}.${setting}`)
}

const LABEL = { 'workers-merge': 'workers can merge', 'agents-approve': 'agents can approve tool calls' }
export function boundaryHow(setting, sock, sess) {
  const lines = [
    `"${LABEL[setting]}" is off. A lead or a human can turn it on:`,
    `      fleet-project set -s ${sock} ${setting} on                 # the whole project (or the grid's , page)`,
  ]
  if (sess) lines.push(`      fleet-project set -s ${sock} ${setting} on --session ${sess}   # this session only`)
  return lines.join('\n')
}

// The refusals, word for word the shell guard's, so a session reads one rule whichever
// door refused it. Each begins `ghostfleet:` as the shell's do.
export const SETTING_REFUSAL = [
  'ghostfleet: a worker does not change its own boundaries.',
  '  "workers can merge" and "agents can approve tool calls" are set by the lead (from the',
  "  main checkout) or a human (the grid's , page) — never by a session in a linked worktree,",
  '  which is the session they bound. Ask the lead if your task needs one.',
].join('\n')

export function mergeRefusal(where, branch, sock, sess) {
  return [
    'ghostfleet: a worker does not merge its own PR — the LEAD merges.',
    `  This session runs in a linked worktree (${where}${branch ? `, branch ${branch}` : ''}), which makes`,
    '  it a worker. The lead scans what you opened and merges it from the main checkout;',
    '  a green check is its signal to look, not yours to merge.',
    '',
    '  What to do instead: push, make sure the PR is open against the integration branch,',
    '  report the PR number, and end your turn.',
    '',
    boundaryHow('workers-merge', sock, sess).split('\n').map(l => `  ${l}`).join('\n'),
  ].join('\n')
}

// Every refusal from a guard that could not decide. A guard that cannot tell refuses:
// that is the whole difference from the shell version, which lets the call through.
export const failedClosed = (what, why) =>
  `ghostfleet: ${what} could not be checked, so it is refused (a guard fails closed): ${why}. ` +
  'Nothing ran. If this repeats, the fleet\'s own commands (fleet-answer, fleet-jarvis, gh, git) ' +
  'are not answering from this session; tell the lead or a human rather than working around it.'

// ── fleet-answer, as a Bash command ─────────────────────────────────────────
//
// Each `fleet-answer` the command runs, as the argv it would get, so the mod can ask
// `fleet-answer --check` the same question first. Words are split the way a shell splits
// plain quoting ('…', "…", \x). Anything a shell would EXPAND ($, `, a subshell, a
// redirect) cannot be known from here: such a command answers null and is left to
// fleet-answer's own check, which still runs when the command does.
export function answerCalls(cmd) {
  const words = shellWords(String(cmd || ''))
  if (!words) return null
  const calls = []
  let start = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.op) { start = true; continue }
    if (start && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) continue
    if (start && /(^|\/)fleet-answer$/.test(w.text)) {
      const argv = []
      for (i++; i < words.length && !words[i].op; i++) argv.push(words[i].text)
      i--
      calls.push(argv)
    }
    start = false
  }
  return calls
}

// [{text}|{op}] or null when the line holds something only a shell can expand.
function shellWords(s) {
  const out = []
  let cur = null
  const push = () => { if (cur !== null) out.push({ text: cur }); cur = null }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return null
      cur = (cur ?? '') + s.slice(i + 1, j); i = j; continue
    }
    if (c === '"') {
      let t = ''
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '$' || s[i] === '`') return null
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) i++
        t += s[i]
      }
      if (i >= s.length) return null
      cur = (cur ?? '') + t; continue
    }
    if (c === '\\') { if (i + 1 >= s.length) return null; cur = (cur ?? '') + s[++i]; continue }
    if ('$`()<>{}'.includes(c)) return null
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      push()
      while (i + 1 < s.length && (s[i + 1] === '|' || s[i + 1] === '&')) i++
      out.push({ op: true }); continue
    }
    if (c === ' ' || c === '\t') { push(); continue }
    cur = (cur ?? '') + c
  }
  push()
  return out
}

// ── Jarvis ──────────────────────────────────────────────────────────────────
//
// The MCP tools lib/jarvis.mjs mcpConfirmSpec names, and the server they belong to. Only
// these are asked about; every other call costs nothing.
export const JARVIS_TOOLS = new Set([
  'fleet_stop', 'fleet_worktree_remove', 'fleet_project_remove', 'fleet_answer',
  'fleet_spawn', 'fleet_companion', 'fleet_send',
])
export function fleetTool(tool) {
  const m = /^mcp__ghostfleet__(fleet_[a-z_]+)$/.exec(String(tool || ''))
  return m ? m[1] : ''
}

// The tool's own arguments: the envelope keys the engine adds are not the call's.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
export const callArgs = e => Object.fromEntries(Object.entries(e || {}).filter(([k]) => !ENVELOPE.has(k)))

// Could lib/jarvis.mjs bashSpec act on this command at all? A strict SUPERSET of its rules
// (test/run.sh holds it to that), so the gate is asked only when it might say no. Every
// rule there names gh, git, tmux, a fleet- command, Jarvis's own files or verbs, or Jarvis's
// socket after -L/-s; anything else it answers `ok`. Without this, Jarvis's every `ls` would
// need node and the gate, and one broken gate would refuse the whole shell.
export function jarvisMightAct(cmd, sock, jdir) {
  const c = String(cmd || '')
  if (/\b(gh|git|tmux|jarvis)\b|fleet-|\.config\/ghostfleet/.test(c)) return true
  if (jdir && c.includes(jdir)) return true
  const esc = String(sock || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Boolean(esc) && new RegExp(`-[Ls]\\s*${esc}\\b`).test(c)
}

// The marker's sock= line (lib/jarvis.mjs readMarker reads the rest).
export function markerSock(text) {
  const m = /^sock=(.*)$/m.exec(String(text || ''))
  return m ? m[1].trim() : ''
}
