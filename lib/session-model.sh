# lib/session-model.sh — which MODEL a Claude session starts on, and how a running one is moved.
# Sourced (by bin/agent-here, bin/fleet-model, bin/fleet-project). Needs lib/model-kind.sh's
# model_name_valid, which it sources itself.
#
# WHY. A fleet that runs every session on the profile default runs all of them on the most
# expensive model. Measured on one personal fleet: about fifteen topic sessions, a master and a
# headless bot, every one on the top model at the highest effort — including the session that
# keeps a list. Only NEW workers could be given a model (fleet-spawn --model, lib/model-kind.sh),
# and a by-hand `/model sonnet` sent into a running session had three faults: Claude Code saved it
# as the PROFILE's default for every future session, one session refused slash text (fixed in
# fleet-send's delivery), and the session came back on the profile default the next time it
# slept or restarted. bin/fleet-model fixes the first and the last; this file is the part every
# launch shares.
#
# PRECEDENCE, most explicit first. Resolved by agent-here at EVERY start of a Claude session
# (spawn, open, restart, wake, reopen, the grid), because those all launch through it:
#
#   <fleet-dir>/<sock>.<slot>.model    the per-session PIN — fleet-model wrote it, the newest
#                                      explicit choice about this one session
#   CLAUDE_FLEET_MODEL                 what the session was created with: fleet-spawn --model,
#                                      or its --kind map (lib/model-kind.sh)
#   <fleet-dir>/<sock>.model           the PROJECT default (fleet-project set <p> model <m>),
#                                      for every session of the project EXCEPT master
#   (nothing)                          the profile default: Claude Code's own settings.json
#
# MASTER IS NOT GIVEN THE PROJECT DEFAULT. The lead reads every worker's output and decides what
# ships, so moving it is a call made about it by name: `fleet-model master sonnet` pins it like
# any other session. A project default that quietly reached the lead would change who checks the
# work without anybody having chosen that.
#
# THERE IS STILL NO ALL-PROJECTS DEFAULT, for lib/model-kind.sh's reason: a model is a quality
# call made project by project. The profile default is Claude Code's, and fleet-model works to
# leave it exactly as it was.
#
# CLAUDE ONLY. A model name is vendor-specific (lib/agent-switch.sh keeps one per agent for that
# reason), so agent-here resolves this for claude sessions alone, and fleet-model refuses others.
#
# THE FILES, all one line, all in the profile's fleet dir beside the session's other markers:
#   <sock>.<slot>.model                  the pin (moved by fleet-rename, cleared by fleet-stop)
#   <sock>.model                         the project default
#   <sock>.<slot>.model-switch           a switch waiting for the session to go idle
#   <sock>.<slot>.model-switch.pid       the watcher that will make it (one per session)
#   <sock>.<slot>.model-switch.result    `<epoch> ok|failed <what happened>`, the last outcome
#   <sock>.<slot>.model-switch.log       the watcher's trail, appended
#   <sock>.<slot>.settings-backup.json   the profile's settings.json as it was just before
#                                        fleet-model put its `model` key back

_sm_src="${BASH_SOURCE[0]}"
while [ -L "$_sm_src" ]; do _sm_l="$(readlink "$_sm_src")"; case "$_sm_l" in /*) _sm_src="$_sm_l" ;; *) _sm_src="$(dirname "$_sm_src")/$_sm_l" ;; esac; done
SESSION_MODEL_LIB="$(cd "$(dirname "$_sm_src")" && pwd)"
# shellcheck source=lib/model-kind.sh
. "$SESSION_MODEL_LIB/model-kind.sh"

# _sm_read <file> -> the model it holds, or nothing. A file that does not hold a model name is
# ignored with a warning on stderr, as model_kind_resolve does: a typo must fall back to what the
# person had before, never reach the CLI.
_sm_read() {
  local f="$1" raw
  [ -f "$f" ] || return 0
  # first line, whitespace stripped — read and a parameter expansion, not `head | tr`: this runs for
  # every asleep or lost row of fleet-list, and two exec'd processes per file add up.
  raw=""; IFS= read -r raw < "$f" 2>/dev/null; raw="${raw//[[:space:]]/}"
  if model_name_valid "$raw"; then printf '%s' "$raw"; return 0; fi
  printf 'ghostfleet: ignoring %s — "%s" is not a model name\n' "$f" "$raw" >&2
}

session_model_pin()     { [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ -n "${3:-}" ] && _sm_read "$1/$2.$3.model"; return 0; }
session_model_project() { [ -n "${1:-}" ] && [ -n "${2:-}" ] && _sm_read "$1/$2.model"; return 0; }

# session_model_resolve <fleet-dir> <sock> <slot> [<launch model>]
#   -> `<model><TAB><source>`, source one of pin|spawn|project|profile (model empty for profile).
# The tab is safe here: neither field can be empty except the model, which is FIRST, and every
# reader takes the two with `IFS=$'\t' read -r m src`, where a leading empty field still lands
# in m. (A tab is IFS-whitespace and collapses an empty field in the MIDDLE; CLAUDE.md.)
session_model_resolve() {
  local dir="${1:-}" sock="${2:-}" slot="${3:-}" env="${4:-}" m
  m="$(session_model_pin "$dir" "$sock" "$slot")"
  [ -n "$m" ] && { printf '%s\tpin\n' "$m"; return 0; }
  if [ -n "$env" ] && model_name_valid "$env"; then printf '%s\tspawn\n' "$env"; return 0; fi
  if [ "$slot" != master ]; then
    m="$(session_model_project "$dir" "$sock")"
    [ -n "$m" ] && { printf '%s\tproject\n' "$m"; return 0; }
  fi
  printf '\tprofile\n'
}

# What each source means, as a person reads it.
session_model_source_label() {
  case "$1" in
    pin)     printf "this session's pin (fleet-model)" ;;
    spawn)   printf 'what it was spawned with (fleet-spawn --model / --kind)' ;;
    project) printf "the project default (fleet-project set <project> model)" ;;
    profile) printf "the profile default (Claude Code's settings.json)" ;;
    *)       printf '%s' "$1" ;;
  esac
}
