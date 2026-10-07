// lib/mod-status.mjs — when to believe the state the ghostfleet mod wrote.
//
// mods/ghostfleet writes a Claude session's state into its status record from INSIDE
// Claude Code (`source: "mod"`, `state`, `mod: { pid, hb }`): a turn started, a turn
// completed, a dialog is up. That is exact where the pane regex guesses, so a reader
// that has it uses it and does not read the pane at all. But an exact state is only as
// good as the process still writing it, and a record outlives its writer in three ways
// this has to tell apart from "ready for an hour":
//
//   the process died (a crash, a kill -9, a machine that went down mid-turn): the record
//     still says `working`, forever. The pid answers that at once.
//   the plugin stopped (disabled with /plugin, failed to load after an update, an older
//     Claude without mods): the process is alive and nobody writes. The heartbeat, which
//     the mod refreshes every minute whatever the state, answers that within MOD_STALE_S.
//   the record was never the mod's: no `source`, no `mod`. Every pre-mod record, every
//     other agent's.
//
// Any of the three, and the answer is null: the caller falls back to what it did before
// the mod existed (the pane regex, the shell hook's status), which is still right.
//
// Node builtins only, like lib/fleet-scan.mjs: this is on the import path of the grid,
// the phone server and the digest.

// Two missed heartbeats and a half. One is a busy event loop; two is a plugin that is
// not running.
export const MOD_STALE_S = 150;

const STATES = new Set(['working', 'ready', 'interrupted', 'need-you', 'idle']);

// EPERM is a process that exists and is not ours to signal: alive.
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The mod's state for this record, or null when it is not to be believed.
export function modState(rec, nowMs = Date.now(), alive = pidAlive) {
  if (!rec || rec.source !== 'mod' || !STATES.has(rec.state) || !rec.mod) return null;
  const hb = Number(rec.mod.hb) || 0;
  if (!hb || nowMs - hb > MOD_STALE_S * 1000) return null;
  const pid = Number(rec.mod.pid) || 0;
  if (pid && !alive(pid)) return null;
  return rec.state;
}

// "This account is spent", from the engine's own figure rather than the pane: the 5h
// window at or past 100% and not yet reset. Answers the reset as the grid prints it
// (`10:20pm`), or null. Same contract as the pane reader it stands in for, which fails
// CLOSED: a missing figure is never a limit.
export function modLimitAt(rec, nowS = Math.floor(Date.now() / 1000)) {
  const w = rec && rec.usage && rec.usage.limits && rec.usage.limits.five_hour;
  if (!w || !(Number(w.pct) >= 100)) return null;
  const resets = Number(w.resets) || 0;
  if (resets && resets <= nowS) return null;
  if (!resets) return 'soon';
  const d = new Date(resets * 1000);
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m}${h < 12 ? 'am' : 'pm'}`;
}
