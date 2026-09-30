# lib/boundary.sh — the two boundary SETTINGS, read in one place. Sourced, not run.
#
#   workers-merge    a session in a linked worktree may merge a PR (hooks/fleet-guard.sh)
#   agents-approve   an agent may send an approving key to a permission dialog
#                    (bin/fleet-answer)
#
# Both default OFF. Some fleets run workers that are the master of their own task and
# legitimately merge and approve for it, so each is a setting rather than a hard block —
# per PROJECT, and per SESSION for the one worker that is the sub-master of its task while
# its siblings stay blocked. Markers in the fleet dir, the same shape as notify-lead:
#
#   <sock>.<setting>                     the project is on
#   <sock>.<session>.<setting>           this session is on
#   <sock>.<session>.<setting>-off       this session is off, whatever the project says
#
# MOST SPECIFIC WINS, as it does for notify-lead. Written by `fleet-project set` (and the
# grid's settings page, which calls it); moved by fleet-rename, cleared by fleet-stop.
# Jarvis never consults these: its confirm-list stays on whatever a project says.

BOUNDARY_SETTINGS="workers-merge agents-approve"

# boundary_on <setting> <fleet-dir> <sock> [<session>] -> 0 when on
boundary_on() {
  local s="$1" dir="$2" sock="$3" sess="${4:-}"
  [ -n "$s" ] && [ -n "$dir" ] && [ -n "$sock" ] || return 1
  if [ -n "$sess" ]; then
    [ -f "$dir/$sock.$sess.$s-off" ] && return 1
    [ -f "$dir/$sock.$sess.$s" ] && return 0
  fi
  [ -f "$dir/$sock.$s" ]
}

# The label a person reads, for refusals and the settings page.
boundary_label() {
  case "$1" in
    workers-merge)  printf 'workers can merge' ;;
    agents-approve) printf 'agents can approve tool calls' ;;
  esac
}

# How to turn it on, for a refusal to name: the project-wide form and the one-session form.
boundary_how() {   # <setting> <sock> [<session>]
  printf '"%s" is off. A lead or a human can turn it on:\n' "$(boundary_label "$1")"
  printf '      fleet-project set -s %s %s on                 # the whole project (or the grid'"'"'s , page)\n' "$2" "$1"
  [ -n "${3:-}" ] && printf '      fleet-project set -s %s %s on --session %s   # this session only\n' "$2" "$1" "$3"
  return 0
}
