#!/usr/bin/env bash
# ghostfleet PreToolUse guard.
#
# Claude Code ships its OWN worktree tool, EnterWorktree, and its semantics are the
# opposite of what a fleet lead means by "start a worktree": it creates the tree at
# <repo>/.claude/worktrees/<name> and then RELOCATES THE CALLING SESSION into it. A
# master told "start a worktree and open a PR" reaches for it, the worktree appears,
# and master silently walks off its own checkout — no new session, no new pane, and
# the lead you were talking to is now somewhere else. It looks half-right, which is
# why it went unnoticed twice, in two different projects.
#
# fleet-spawn's own nesting guard cannot catch this: it only fires if fleet-spawn is
# called at all, and here it never was. So the refusal has to sit in front of the
# TOOL, which is what a PreToolUse hook is.
#
# Blocking contract: exit 2, message on stderr — Claude Code feeds stderr back to the
# session as the reason. This is deliberately a SEPARATE script from fleet-event.sh,
# which must always exit 0; mixing a blocking hook into it would put that invariant
# one typo away from failing a session on every event.
#
# Scope, kept narrow on purpose:
#   - only PreToolUse, only EnterWorktree
#   - only inside a fleet (a plain Claude Code session outside ghostfleet keeps the
#     built-in — it is the right tool there, and there is no fleet to confuse)
#   - ExitWorktree is NEVER blocked: a session that already got moved (or one from
#     before this hook existed) needs its way back out.
#   - CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1 overrides, same escape-hatch shape as
#     CLAUDE_FLEET_ALLOW_NESTED in fleet-spawn.

# Route by the LIVE tmux server, not a possibly-stale CLAUDE_FLEET_SOCK — same
# reasoning as fleet-event.sh: a --resume/--fork Claude can carry an old env var.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

# Never break a session over a missing dependency or an unreadable payload.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
IFS=$'\x1f' read -r EVENT TOOL CWD < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.tool_name // ""),
      (.cwd // .workspace.current_dir // "") ] | join("\u001f")' 2>/dev/null
)

[ "$EVENT" = "PreToolUse" ] || exit 0
[ "$TOOL" = "EnterWorktree" ] || exit 0
[ "${CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE:-0}" != 1 ] || exit 0
[ -n "${CLAUDE_FLEET_SOCK:-}" ] || exit 0        # not a fleet session — built-in is fine

CWD="${CWD:-$PWD}"
GITROOT="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$GITROOT" ] || exit 0                      # not a repo — nothing to redirect to

# Which advice applies turns on whether this session is a lead or already a leaf.
# A linked worktree has its own git-dir under the shared common dir; in the main
# checkout the two are the same path. Exact, unlike guessing from the folder name
# (the same test fleet-spawn uses).
_gd="$(git -C "$CWD" rev-parse --git-dir 2>/dev/null)"
_gcd="$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)"
_br="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"

{ echo "ghostfleet: EnterWorktree is the WRONG tool in a fleet session."
  echo "  It would create <repo>/.claude/worktrees/… and MOVE THIS SESSION into it —"
  echo "  leaving the thread you are talking to somewhere else. ghostfleet worktrees are"
  echo "  siblings of the repo, and a worker is a NEW session; you keep yours."
  echo
  if [ "$_gd" != "$_gcd" ]; then
    echo "  You are already IN a worktree ($GITROOT, branch $_br) — you are a worker, a leaf."
    echo "  Start fresh work where you stand; no new worktree, no new session:"
    echo "      git fetch origin && git checkout -B <new-branch> origin/main"
  else
    echo "  Hand the work to a worker instead (you keep this thread and can keep working):"
    echo "      fleet-spawn <name> --branch <branch> --from origin/main --prompt \"…\""
    echo "  or the MCP tool: fleet_spawn with name/branch/prompt."
    echo "  REUSE BEFORE PROLIFERATE — check 'fleet-worktrees' for a free one first."
    echo
    echo "  Doing it yourself, right here, is also fine — that needs no worktree at all:"
    echo "      git checkout -b <branch> && …"
  fi
  echo
  echo "  Deliberate override: CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1"; } >&2
exit 2
