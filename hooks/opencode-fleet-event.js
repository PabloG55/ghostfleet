// ghostfleet event bridge for OpenCode.
//
// The OpenCode counterpart of hooks/fleet-event.sh. Claude Code pushes need-you/done
// through its hook system; OpenCode pushes the same information through its plugin
// event bus, so a fleet worker running OpenCode gets REAL blocked-detection instead
// of pane guesswork.
//
// Installed once, globally, into ~/.config/opencode/plugin/ (install.sh). OpenCode
// auto-discovers plugins from there — verified — so this needs no opencode.json entry
// and, more importantly, no file written into the user's checkout.
//
// It is INERT outside a fleet: with no CLAUDE_FLEET_SOCK in the environment every
// handler returns immediately, so plain `opencode` in a normal terminal is unaffected.
//
// Event mapping (all three observed firing against OpenCode 1.18.11):
//   permission.asked -> need-you   the run stopped and a human must answer
//   session.idle     -> ready      the turn finished (fires once per turn)
//   session.error    -> need-you   it broke; someone should look
//   message.updated  -> working    a turn is under way
//
// Must never throw: a plugin exception would surface inside the user's coding
// session. Every handler is wrapped.

import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const env = process.env
const SOCK = env.CLAUDE_FLEET_SOCK || ""
const SLOT = env.CLAUDE_FLEET_SLOT || ""
const ZELL = env.ZELLIJ_SESSION_NAME || ""
const FLEET_DIR =
  env.CLAUDE_FLEET_DIR ||
  join(env.CLAUDE_CONFIG_DIR || join(env.HOME || "", ".claude"), "fleet")

const now = () => Math.floor(Date.now() / 1000)
const quiet = (fn) => { try { return fn() } catch { return undefined } }

export const GhostfleetEvents = async ({ directory, worktree }) => {
  // Not inside a fleet pane -> do nothing at all.
  if (!SOCK) return {}

  const cwd = worktree || directory || process.cwd()
  // The grid reads the last assistant turn out of a transcript to put on the card.
  // Give it one in the shape it already parses (one JSON object per line, Claude's
  // {type:"assistant",message:{content:[{type:"text"}]}}), rather than pointing it at
  // OpenCode's SQLite store. Without this the grid would fall back to
  // newestTranscript(cwd) and show a stale CLAUDE conversation from the same folder.
  const transcript = join(FLEET_DIR, `${SOCK}.${SLOT || "session"}.opencode.jsonl`)

  quiet(() => mkdirSync(FLEET_DIR, { recursive: true }))

  let sessionID = ""
  const assistantMsgs = new Set()   // message ids known to be assistant-authored
  const seenParts = new Map()       // part id -> last text written (de-dupes deltas)
  const seenUserMsgs = new Set()    // user message ids already counted as a new turn

  // Atomic, same as fleet-event.sh: write a temp file then rename, so the grid never
  // reads a half-written status.
  const writeStatus = (status) => quiet(() => {
    if (!sessionID) return
    const body = JSON.stringify({
      session_id: sessionID,
      zellij: ZELL,
      sock: SOCK,
      slot: SLOT,
      cwd,
      folder: basename(cwd),
      branch: "",          // the grid derives this from cwd when empty
      status,
      transcript,
      ts: now(),
      agent: "opencode",
    })
    const tmp = join(FLEET_DIR, `.${sessionID}.${process.pid}.tmp`)
    writeFileSync(tmp, body)
    renameSync(tmp, join(FLEET_DIR, `${sessionID}.json`))
  })

  // Workers only, never the lead — matching fleet-event.sh, which never reports the
  // master's own turns into the master's inbox.
  const inbox = (ev, detail) => quiet(() => {
    if (!SLOT || SLOT === "master") return
    appendFileSync(
      join(FLEET_DIR, `${SOCK}.inbox`),
      `${now()}\t${SLOT}\t${ev}\t${String(detail || "").replace(/[\n\r\t]/g, " ").slice(0, 120)}\n`,
    )
  })

  const appendTranscript = (text) => quiet(() => {
    appendFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }) + "\n")
  })

  // A new prompt un-parks the session, exactly like UserPromptSubmit does for Claude.
  const clearParked = () => quiet(() => {
    if (!SLOT) return
    for (const f of [join(FLEET_DIR, `${SOCK}.${SLOT}.parked`), join(FLEET_DIR, `${SLOT}.parked`)]) {
      try { unlinkSync(f) } catch {}
    }
  })

  return {
    event: async ({ event }) => quiet(() => {
      const t = event?.type
      const p = event?.properties || {}
      if (p.sessionID) sessionID = p.sessionID

      switch (t) {
        case "session.created":
          writeStatus("idle")
          break

        case "message.updated": {
          const info = p.info || {}
          if (info.role === "assistant") { if (info.id) assistantMsgs.add(info.id) }
          else if (info.role === "user") {
            // OpenCode REPUBLISHES the same user message after the turn ends (once
            // more carrying a `summary`), and that late copy arrives AFTER
            // session.idle. Treating every copy as "a new turn started" rewrote the
            // status back to working one second after reporting ready, so a finished
            // worker looked permanently busy to anything reading the status file.
            // Only the first sighting of a message id starts a turn.
            if (info.id && seenUserMsgs.has(info.id)) break
            if (info.id) seenUserMsgs.add(info.id)
            clearParked()
            writeStatus("working")
          }
          break
        }

        case "message.part.updated": {
          // Only assistant text, and only once per part — the same part id is
          // republished as the text streams in.
          const part = p.part || {}
          if (part.type !== "text" || !part.text) break
          if (part.messageID && !assistantMsgs.has(part.messageID)) break
          if (seenParts.get(part.id) === part.text) break
          seenParts.set(part.id, part.text)
          break
        }

        case "permission.asked": {
          const what = p.metadata?.command || p.permission || "permission"
          writeStatus("need-you")
          inbox("need-you", `permission: ${what}`)
          break
        }

        case "session.error": {
          const msg = p.error?.data?.message || p.error?.name || "session error"
          writeStatus("need-you")
          inbox("need-you", `error: ${msg}`)
          break
        }

        case "session.idle": {
          // End of turn. Flush the last assistant text so the card has something to
          // show, then report ready + done.
          let last = ""
          for (const v of seenParts.values()) if (v) last = v
          if (last) { appendTranscript(last); seenParts.clear() }
          writeStatus("ready")
          inbox("done", basename(cwd))
          break
        }
      }
    }),
  }
}
