#!/usr/bin/env node
// codex's half of install.sh's hook wiring: hooks/codex-fleet-event.sh registered for six
// events in $CODEX_HOME/hooks.json, and trusted in $CODEX_HOME/config.toml.
//
//   codex-hooks.mjs install   <bridge>   ours in, the user's own hooks kept; idempotent
//   codex-hooks.mjs uninstall            ours out; the user's file back as it was
//   codex-hooks.mjs status    [<bridge>] what is wired; exit 0 only when all of it is
//
// TWO FILES, BECAUSE A HOOK CODEX HAS NOT BEEN TOLD TO TRUST DOES NOT RUN. codex 0.166.0
// reads hooks.json (or [hooks] in config.toml), and before running a hook it looks for
// [hooks.state."<hooks.json>:<event>:<group>:<handler>"] trusted_hash in config.toml. With no
// match it opens "Hooks need review" at startup, and "Continue without trusting" runs none
// of them: no done, no need-you, and — the one that matters — no Telegram guard. So
// registering the hooks without trusting them would be wiring that reads as installed and
// does nothing. There is no codex command that trusts a hook (0.166.0 has no `codex hooks`),
// so the record is written here, the way codex writes it from that dialog.
//
// THE HASH IS CODEX'S, RECOMPUTED (codex-rs/hooks discovery.rs hook_hash, codex-config
// fingerprint.rs version_for_toml): sha256 over the key-sorted compact JSON of
// {event_name, matcher?, hooks: [{type, command, timeout, async}]}, with the timeout as codex
// normalizes it — SessionEnd and Interrupt clamped to 1..3s, every other event 600s when
// unset. It covers the COMMAND, not the script the command runs, so cf-sync can change the
// bridge without asking anyone to trust it again; a new runtime PATH is a new command, and
// install rewrites the record for it. The key is the hook's POSITION, so a hook the user
// inserts before ours moves ours to a key with no record, and codex asks about it at the
// next start. test/fixtures/codex-hook-trust.json holds six hashes codex wrote itself from
// its dialog; the suite holds this code to them.
//
// THE USER'S FILES. Both are written in place — never renamed over, which would take the
// file's mode with it — and only where they change: a second install changes no byte.
//   hooks.json: ours are the groups whose command runs codex-fleet-event.sh <Event>; they are
// removed and appended again after the user's groups, so the user's own hooks run first and
// keep their order. An install into a file that has none of ours keeps its bytes beside it
// (hooks.json.pre-ghostfleet); uninstall writes those bytes back when what is left equals
// them, so a file nobody touched in between comes back byte for byte, and then removes them. A file that is not
// JSON, or whose `hooks` is not an object, is left alone and named.
//   config.toml: TOML has no parser in node's stdlib, so this edits lines, and only lines it
// can prove are its own: a [hooks.state."<this hooks.json>:…"] table whose trusted_hash is
// the hash of OUR command. Everything else is copied through. A table codex already wrote
// for our key (the user pressed Trust) is updated, never written twice: a second table of
// the same name is a TOML error, and codex then refuses to start at all ("duplicate key",
// measured). That is also the backstop: codex reads the file before the write and again
// after it (`codex features list` loads config.toml), and a write it cannot read is put back
// as it was, byte for byte.
//
// WHERE IT IS DECIDED THAT A FLEET HEARS NOTHING: not here. A work profile's fleet is
// decided at run time, in the bridge's first lines, because codex has one config for every
// profile; these hooks are registered for every codex session on the machine and are inert
// outside a non-work fleet.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'Interrupt']
// The three Telegram depends on: the prompt marks the turn, the guard holds it, the Stop ends it.
export const GUARD_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Stop']
const SHORT = new Set(['SessionEnd', 'Interrupt'])   // codex caps these at 3s (normalize_command_hook)

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex')
const snake = (e) => e.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase())
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export const commandFor = (bridge, ev) => `${shq(bridge)} ${ev}`
export const handlerFor = (bridge, ev) => ({ type: 'command', command: commandFor(bridge, ev), timeout: SHORT.has(ev) ? 3 : 30 })

// Ours: a command handler that runs codex-fleet-event.sh with an event, from any runtime path.
const OURS = /codex-fleet-event\.sh'? ([A-Za-z]+)$/
export const oursOf = (h) => (h && h.type === 'command' && typeof h.command === 'string' && (h.command.match(OURS) || [])[1]) || ''
// The script a command of ours runs, for "does it exist": the quoted path, or the first word.
const scriptOf = (cmd) => { const m = cmd.match(/^'((?:[^']|'\\'')*)'/); return m ? m[1].replace(/'\\''/g, "'") : cmd.split(' ')[0] }

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

export function hookHash(ev, matcher, h) {
  const t = h.timeout == null ? null : Number(h.timeout)
  const timeout = SHORT.has(ev) ? Math.min(Math.max(t ?? 1, 1), 3) : Math.max(t ?? 600, 1)
  const id = { event_name: snake(ev), hooks: [{ type: 'command', command: h.command, timeout, async: h.async === true }] }
  if (matcher != null) id.matcher = matcher
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortKeys(id))).digest('hex')
}

// ── hooks.json ───────────────────────────────────────────────────────────────
const readText = (f) => { try { return fs.readFileSync(f, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
function parseHooks(text, file) {
  if (text == null) return { hooks: {} }
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error(`${file} is not JSON — not touching it`) }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} is not a JSON object — not touching it`)
  if (doc.hooks == null) doc.hooks = {}
  if (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) throw new Error(`${file}: "hooks" is not an object — not touching it`)
  return doc
}
// The document without our handlers; a group left empty goes, and so does an event left empty.
function withoutOurs(doc) {
  const out = { ...doc, hooks: {} }
  const removed = []
  for (const [ev, groups] of Object.entries(doc.hooks || {})) {
    if (!Array.isArray(groups)) { out.hooks[ev] = groups; continue }
    const kept = []
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue }
      const mine = g.hooks.filter((h) => oursOf(h) === ev)
      for (const h of mine) removed.push({ ev, matcher: g.matcher, h })
      if (!mine.length) { kept.push(g); continue }
      const rest = g.hooks.filter((h) => oursOf(h) !== ev)
      if (rest.length) kept.push({ ...g, hooks: rest })
    }
    if (kept.length) out.hooks[ev] = kept
  }
  return { doc: out, removed }
}
const dropEmpty = (doc) => ({ ...doc, hooks: Object.fromEntries(Object.entries(doc.hooks || {}).filter(([, g]) => !Array.isArray(g) || g.length)) })
const render = (doc) => JSON.stringify(doc, null, 2) + '\n'

// ── config.toml, by lines ────────────────────────────────────────────────────
const isHeader = (l) => /^\s*\[/.test(l)
const HASH_LINE = /^\s*trusted_hash\s*=\s*"([^"]*)"\s*$/
// Every [hooks.state."<hooksFile>:<event>:<g>:<h>"] table: where it starts, where its last
// line is, and its recorded hash.
function stateTables(lines, hooksFile) {
  const pre = `[hooks.state."${hooksFile}:`
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l.startsWith(pre) || !l.endsWith('"]')) continue
    const key = l.slice('[hooks.state."'.length, -2)
    const m = key.slice(hooksFile.length + 1).match(/^([a-z_]+):(\d+):(\d+)$/)
    if (!m) continue
    let last = i, hash = null, hashAt = -1
    for (let j = i + 1; j < lines.length && !isHeader(lines[j]); j++) {
      if (lines[j].trim() !== '') last = j
      const h = lines[j].match(HASH_LINE)
      if (h) { hash = h[1]; hashAt = j }
    }
    out.push({ start: i, last, key, event: m[1], group: Number(m[2]), handler: Number(m[3]), hash, hashAt,
               disabled: lines.slice(i + 1, last + 1).some((x) => /^\s*enabled\s*=\s*false\s*$/.test(x)) })
  }
  return out
}
// Remove tables (and the one blank line each was set off by), last first so indexes hold.
function removeTables(lines, tabs) {
  const out = lines.slice()
  for (const t of tabs.slice().sort((a, b) => b.start - a.start)) {
    const from = t.start > 0 && out[t.start - 1] === '' ? t.start - 1 : t.start
    out.splice(from, t.last - from + 1)
  }
  return out
}
const keyOf = (hooksFile, ev, g, h) => `${hooksFile}:${snake(ev)}:${g}:${h}`
// A key goes inside a TOML basic string; a path that would need escaping there is not one
// this edits (and status says so), rather than one it might get wrong.
const tomlSafe = (s) => !/["\\\u0000-\u001f\u007f]/.test(s)

// ── codex itself, as the judge of whether its config still reads ─────────────
const codexBin = (env) => env.CODEX_BIN || 'codex'
function features(home, env = process.env) {
  const r = spawnSync(codexBin(env), ['features', 'list'], { env: { ...env, CODEX_HOME: home }, encoding: 'utf8', timeout: 30000 })
  const m = (r.stdout || '').match(/^hooks\s+\S+\s+(true|false)\s*$/m)
  return { ok: r.status === 0, hooks: m ? m[1] === 'true' : null, err: (r.stderr || r.error?.message || '').trim().split('\n').slice(0, 6).join(' ') }
}

function paths(home) {
  let real = home
  try { real = fs.realpathSync(home) } catch {}
  return { home: real, hooksFile: path.join(real, 'hooks.json'), configFile: path.join(real, 'config.toml'),
           backup: path.join(real, 'hooks.json.pre-ghostfleet') }
}
const write = (f, text) => fs.writeFileSync(f, text)   // in place: the file keeps its mode

// Where each of our handlers sits in a document: event -> { g, h, matcher, handler }.
function positions(doc) {
  const at = {}
  for (const [ev, groups] of Object.entries(doc.hooks || {})) {
    if (!Array.isArray(groups)) continue
    groups.forEach((g, gi) => (g && Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => {
      if (oursOf(h) === ev && !at[ev]) at[ev] = { g: gi, h: hi, matcher: g.matcher ?? null, handler: h }
    }))
  }
  return at
}

// config.toml with a record for each of ours at its position, and none of ours anywhere else.
function trusted(text, hooksFile, at) {
  let lines = (text ?? '').split('\n')
  const want = Object.entries(at).map(([ev, p]) => ({ ev, key: keyOf(hooksFile, ev, p.g, p.h), hash: hookHash(ev, p.matcher, p.handler) }))
  const ourHash = new Map(want.map((w) => [snake(w.ev), w.hash]))
  const wantKeys = new Set(want.map((w) => w.key))
  lines = removeTables(lines, stateTables(lines, hooksFile).filter((t) => ourHash.get(t.event) === t.hash && !wantKeys.has(t.key)))
  for (const w of want) {
    const t = stateTables(lines, hooksFile).find((x) => x.key === w.key)
    if (t && t.hash === w.hash) continue
    if (t && t.hashAt >= 0) { lines[t.hashAt] = `trusted_hash = "${w.hash}"`; continue }
    if (t) { lines.splice(t.start + 1, 0, `trusted_hash = "${w.hash}"`); continue }
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')   // the file's last line gets its newline
    lines.splice(lines.length - 1, 0, '', `[hooks.state."${w.key}"]`, `trusted_hash = "${w.hash}"`)
    if (lines.length === 4 && lines[0] === '') lines.shift()            // a new file starts at its table
  }
  return lines.join('\n')
}

export function install(bridge, { env = process.env, home = codexHome(env) } = {}) {
  const p = paths(home)
  if (!tomlSafe(p.hooksFile)) throw new Error(`${p.hooksFile}: a path with a quote or backslash in it is not one this edits — trust the hooks in codex's own dialog`)
  const before = features(p.home, env)
  if (!before.ok) throw new Error(`codex cannot read its config as it is, so it is not touched: ${before.err}`)
  if (before.hooks == null) return { changed: false, skipped: 'this codex has no hooks (codex features list shows none)' }
  for (let k = 0; k < 3; k++) {
    const hjText = readText(p.hooksFile), ctText = readText(p.configFile)
    const { doc: rest, removed: had } = withoutOurs(parseHooks(hjText, p.hooksFile))
    const next = { ...rest, hooks: { ...rest.hooks } }
    for (const ev of EVENTS) next.hooks[ev] = [...(next.hooks[ev] || []), { hooks: [handlerFor(bridge, ev)] }]
    const cur = parseHooks(hjText, p.hooksFile)
    const hjNext = same(cur, next) ? hjText : render(next)
    const ctNext = trusted(ctText, p.hooksFile, positions(next))
    if (hjNext === hjText && ctNext === (ctText ?? '')) return { changed: false, hooks: before.hooks }
    // Nothing moved under us while this was worked out (codex writes config.toml itself).
    if (readText(p.hooksFile) !== hjText || readText(p.configFile) !== ctText) continue
    // The backup is the file as it was before ours went in, so it is taken whenever ours go
    // into a file that has none — one left from an earlier history is that history's.
    const bakText = readText(p.backup)
    if (hjNext !== hjText && !had.length) { if (hjText != null) write(p.backup, hjText); else fs.rmSync(p.backup, { force: true }) }
    if (hjNext !== hjText) write(p.hooksFile, hjNext)
    if (ctNext !== (ctText ?? '')) write(p.configFile, ctNext)
    const after = features(p.home, env)
    if (!after.ok) {
      if (ctText == null) fs.rmSync(p.configFile, { force: true }); else write(p.configFile, ctText)
      if (hjText == null) fs.rmSync(p.hooksFile, { force: true }); else write(p.hooksFile, hjText)
      if (bakText == null) fs.rmSync(p.backup, { force: true }); else write(p.backup, bakText)
      throw new Error(`codex could not read ${p.configFile} after the trust records were added, so both files are back as they were: ${after.err}`)
    }
    return { changed: true, hooks: after.hooks }
  }
  throw new Error(`${p.home} kept changing while this ran — run it again`)
}

export function uninstall({ env = process.env, home = codexHome(env) } = {}) {
  const p = paths(home)
  const hjText = readText(p.hooksFile), ctText = readText(p.configFile)
  if (hjText == null) return { changed: false }
  const { doc: rest, removed } = withoutOurs(parseHooks(hjText, p.hooksFile))
  if (!removed.length) { fs.rmSync(p.backup, { force: true }); return { changed: false } }
  let hjNext
  const bak = readText(p.backup)
  if (bak != null) {
    let orig = null
    try { orig = parseHooks(bak, p.backup) } catch {}
    hjNext = orig && same(dropEmpty(orig), dropEmpty(rest)) ? bak : render(rest)
  } else {
    // No backup: the file was ours from the start. Empty of hooks and of anything else, it goes.
    hjNext = Object.keys(rest.hooks).length || Object.keys(rest).length > 1 ? render(rest) : null
  }
  // Records for the handlers removed, by their hash: wherever they sit, they are ours.
  const ours = new Set(removed.map((r) => `${snake(r.ev)} ${hookHash(r.ev, r.matcher ?? null, r.h)}`))
  let ctNext = ctText
  if (ctText != null) {
    const lines = ctText.split('\n')
    ctNext = removeTables(lines, stateTables(lines, p.hooksFile).filter((t) => ours.has(`${t.event} ${t.hash}`))).join('\n')
  }
  if (hjNext == null) fs.rmSync(p.hooksFile, { force: true }); else if (hjNext !== hjText) write(p.hooksFile, hjNext)
  if (ctNext !== ctText) { if (ctNext.trim() === '') fs.rmSync(p.configFile, { force: true }); else write(p.configFile, ctNext) }
  fs.rmSync(p.backup, { force: true })
  return { changed: true, removed: removed.length }
}

// What is wired, read the way codex reads it: each of ours present, its script there, its
// record matching its command at its position and not disabled. No codex call unless asked
// (fleet-telegram asks, once per message: a turn it lets through depends on the answer).
export function state({ env = process.env, home = codexHome(env), bridge = '', withFeatures = false } = {}) {
  const p = paths(home)
  const s = { hooksFile: p.hooksFile, configFile: p.configFile, events: {}, error: '' }
  let doc
  try { doc = parseHooks(readText(p.hooksFile), p.hooksFile) } catch (e) { s.error = e.message; doc = { hooks: {} } }
  const at = positions(doc)
  const ct = readText(p.configFile) ?? ''
  const tabs = stateTables(ct.split('\n'), p.hooksFile)
  for (const ev of EVENTS) {
    const a = at[ev]
    if (!a) { s.events[ev] = 'missing'; continue }
    const script = scriptOf(a.handler.command)
    if (bridge && script !== bridge) { s.events[ev] = 'another runtime'; continue }
    let runs = true
    try { fs.accessSync(script, fs.constants.X_OK) } catch { runs = false }
    if (!runs) { s.events[ev] = 'script missing'; continue }
    const t = tabs.find((x) => x.key === keyOf(p.hooksFile, ev, a.g, a.h))
    s.events[ev] = !t || !t.hash ? 'untrusted' : t.disabled ? 'disabled' : t.hash === hookHash(ev, a.matcher, a.handler) ? 'ok' : 'modified'
  }
  if (withFeatures) { const f = features(p.home, env); s.hooks = f.ok ? f.hooks : null; if (!f.ok) s.error = s.error || f.err }
  s.ok = EVENTS.every((ev) => s.events[ev] === 'ok') && !s.error && (!withFeatures || s.hooks === true)
  s.guardOk = GUARD_EVENTS.every((ev) => s.events[ev] === 'ok') && !s.error && (!withFeatures || s.hooks === true)
  return s
}

// ── the command ──────────────────────────────────────────────────────────────
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [verb, bridge] = process.argv.slice(2)
  try {
    if (verb === 'install') {
      if (!bridge || !path.isAbsolute(bridge)) throw new Error('install needs the bridge\'s absolute path')
      const r = install(bridge)
      const p = paths(codexHome())
      console.log(r.skipped ? `· ${r.skipped}: not wiring codex's event hooks`
        : `${r.changed ? '✓ wired' : '✓ already wired:'} codex event hooks -> ${p.hooksFile}, trusted in ${p.configFile}${r.hooks === false ? ' (codex has hooks turned OFF: features.hooks)' : ''}`)
    } else if (verb === 'uninstall') {
      const r = uninstall()
      console.log(r.changed ? `✓ removed ghostfleet's ${r.removed} codex hooks and their trust records` : '· no ghostfleet codex hooks to remove')
    } else if (verb === 'status') {
      const s = state({ bridge: bridge || '', withFeatures: true })
      for (const ev of EVENTS) console.log(`${ev.padEnd(18)} ${s.events[ev]}`)
      console.log(`${'hooks feature'.padEnd(18)} ${s.hooks == null ? 'unknown' : s.hooks ? 'on' : 'off'}`)
      if (s.error) console.log(`! ${s.error}`)
      process.exit(s.ok ? 0 : 1)
    } else {
      console.error('usage: codex-hooks.mjs install <bridge> | uninstall | status [<bridge>]'); process.exit(2)
    }
  } catch (e) { console.error(`codex-hooks: ${e.message}`); process.exit(1) }
}
