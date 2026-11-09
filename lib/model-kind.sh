# lib/model-kind.sh — which MODEL a worker gets, by the KIND of task it was spawned for. Sourced.
#
# WHY BY KIND. Measured on one busy fleet over 13 days (146 sessions): every worker ran on the
# account default — the most expensive model, at the full context — including the workers whose
# whole task was to read a diff and say yes or no, watch CI, write docs, or assemble a video. One
# verifier was 4.6% of the fleet's spend on its own; two video workers came to about 5%. Those
# tasks do not need the model a build does, and nothing let a lead say so short of remembering
# `--model` on every spawn, which is how it went unsaid.
#
# OPT-IN, PER PROJECT, AND THE DEFAULT DOES NOT MOVE. A kind with no entry here launches exactly
# as before: no --model, the account default. Nothing switches a fleet's model unless someone
# set a map entry for that project, because a quiet change of model is a change of what the
# work is checked by, and nobody would know to look. Precedence, most explicit first:
#
#   fleet-spawn --model X                 always wins: the person named the model
#   <fleet-dir>/<sock>.model-<kind>       this project's map  (fleet-project set … model-<kind>)
#   (nothing)                             the account default, as today
#
# There is no all-projects file, unlike the context ceiling: a ceiling is a cost knob that is
# safe to apply everywhere, a model choice is a quality call made project by project.
#
# CLAUDE WORKERS ONLY. A model name is vendor-specific — `haiku` handed to codex is an error
# (lib/agent-switch.sh keeps a model per agent for that reason) — so a worker on another agent
# keeps its kind, for the record, and starts on that agent's own default.

MODEL_KINDS="verify ci docs video build"

# What each kind is for, as a person reads it in `fleet-project get`.
model_kind_label() {
  case "$1" in
    verify) printf 'verify workers: read a PR or diff and report' ;;
    ci)     printf 'ci workers: watch or fix a pipeline' ;;
    docs)   printf 'docs workers: write or update documentation' ;;
    video)  printf 'video workers: assemble recordings and media' ;;
    build)  printf 'build workers: write the code' ;;
  esac
}

# model_kind_valid <kind> -> exit 0 when it is one of MODEL_KINDS.
model_kind_valid() {
  case " $MODEL_KINDS " in *" ${1:-} "*) [ -n "${1:-}" ] ;; *) return 1 ;; esac
}

# model_name_valid <model> -> exit 0 when it can be a model name. Not a list of models: those
# change every few months and a list would refuse the next one. Only the characters the CLI's
# aliases and ids are made of (`sonnet`, `claude-opus-5-5`, `sonnet[1m]`), which keeps a stray
# space or quote out of the tmux -e that carries it.
model_name_valid() {
  case "${1:-}" in
    ''|default) return 1 ;;
    *[!A-Za-z0-9._:/@\[\]-]*) return 1 ;;
  esac
  [ "${#1}" -le 100 ]
}

# model_kind_resolve <fleet-dir> <sock> <kind> -> prints the mapped model, or nothing.
# A file that does not hold a model name is ignored with a warning on stderr: a typo must fall
# back to the default the person had before, never reach the CLI.
model_kind_resolve() {
  local dir="${1:-}" sock="${2:-}" kind="${3:-}" f raw
  model_kind_valid "$kind" || return 0
  [ -n "$dir" ] && [ -n "$sock" ] || return 0
  f="$dir/$sock.model-$kind"
  [ -f "$f" ] || return 0
  raw="$(head -n 1 "$f" 2>/dev/null | tr -d '[:space:]')"
  if model_name_valid "$raw"; then printf '%s' "$raw"; return 0; fi
  printf 'ghostfleet: ignoring %s — "%s" is not a model name\n' "$f" "$raw" >&2
}
