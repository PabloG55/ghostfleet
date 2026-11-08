# lib/session-idle.sh — is a session between turns, by ONE reading of its pane. Sourced.
#
# Lifted out of lib/agent-switch.sh when bin/fleet-model needed the same wait: both replace or
# reconfigure what a running session is doing, both must never do it mid-turn, and two copies of
# "what counts as idle" would drift the first time one of them learned a new case. The rule is
# agent-switch's, unchanged:
#
#   working   fleet-agent busy says so (exit 0): the agent's own spinner pattern
#   working   fleet-agent blocked says so: a pane stopped on a dialog is mid-turn too, and a
#             change made under it would land in the dialog
#   idle      anything else, INCLUDING "cannot tell" (busy exits 1 or 2) — an agent with no
#             detector would otherwise never be idle at all
#
# One sample is not enough to act on: the caller counts consecutive idle samples (IDLE_N, three
# a second apart by default), because a turn's first second can read idle before the spinner is
# drawn. Needs BIN_DIR (where fleet-agent lives) set by the caller.

# session_idle_sample <sock> <slot> -> exit 0 when this sample reads idle.
session_idle_sample() {
  local sock="$1" slot="$2" rc
  "$BIN_DIR/fleet-agent" busy "$slot" -s "$sock" >/dev/null 2>&1; rc=$?
  [ "$rc" = 0 ] && return 1
  "$BIN_DIR/fleet-agent" blocked "$slot" -s "$sock" >/dev/null 2>&1 && return 1
  return 0
}
