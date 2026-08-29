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
#   - only PreToolUse, only EnterWorktree (and, below, the Agent tool)
#   - only inside a fleet (a plain Claude Code session outside ghostfleet keeps the
#     built-in — it is the right tool there, and there is no fleet to confuse)
#   - ExitWorktree is NEVER blocked: a session that already got moved (or one from
#     before this hook existed) needs its way back out.
#   - CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1 overrides, same escape-hatch shape as
#     CLAUDE_FLEET_ALLOW_NESTED in fleet-spawn.
#
# THE SECOND WRONG TOOL: a subagent, where a worker was meant.
#
# Claude Code can also spawn subagents in-conversation (the Agent tool; Task in older
# builds). For a LEAD that is the same shape of mistake as EnterWorktree and it hides
# better, because it works: the work gets done and something is returned. What is lost
# is that it happened inside this conversation. Nothing appears in fleet-list; the
# governor parks SESSIONS, so a subagent's usage is spent but cannot be shed;
# fleet-inbox never carries its `done`; and fleet-worktrees cannot see a tree it made.
# The lead ends up leading a fleet that does not contain the work it just started.
#
# Measured, in a lead session: told to analyse and then to dispatch, the lead reached
# for two subagents in a row while five workers sat live on the project's own socket —
# and the reason it gave itself was machine load, which is precisely the decision the
# governor exists to make and could not, because it could not see them. Asked about it
# afterwards the answer was "why are u using claude agents and not ghostfleet".
#
# So the Agent branch below refuses DISPATCH from a lead and nothing else:
#   - read-only research types (Explore, Plan) pass — they gather, they do not build,
#     and there is no fleet-spawn shaped like them
#   - a LEAF passes: a worker already in its worktree has no fleet-spawn alternative
#     (fleet-spawn refuses from a linked worktree) and its subagents are its own business
#   - CLAUDE_FLEET_ALLOW_SUBAGENTS=1 overrides

# Route by the LIVE tmux server, not a possibly-stale CLAUDE_FLEET_SOCK — same
# reasoning as fleet-event.sh: a --resume/--fork Claude can carry an old env var.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

# Never break a session over a missing dependency or an unreadable payload.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
# \x1f and not tab, because SUBAGENT is OPTIONAL and tab is IFS-whitespace: an absent
# subagent_type would collapse and shift the field order. Our own wire, so \x1f is the
# right choice here — the rule about tmux's formatter rewriting it does not reach a hook.
IFS=$'\x1f' read -r EVENT TOOL CWD SUBAGENT < <(
  printf '%s' "$input" | jq -r '
    [ (.hook_event_name // ""),
      (.tool_name // ""),
      (.cwd // .workspace.current_dir // ""),
      (.tool_input.subagent_type // "") ] | join("\u001f")' 2>/dev/null
)

[ "$EVENT" = "PreToolUse" ] || exit 0
case "$TOOL" in EnterWorktree|Agent|Task) ;; *) exit 0 ;; esac
[ -n "${CLAUDE_FLEET_SOCK:-}" ] || exit 0        # not a fleet session — built-ins are fine

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

# ── the Agent tool: dispatch belongs to the fleet ─────────────────────────────
# Placed before the EnterWorktree message rather than beside it: the two share the
# lead/leaf test above and nothing else, and interleaving them would put one tool's
# escape hatch in the other's path.
if [ "$TOOL" != "EnterWorktree" ]; then
  [ "${CLAUDE_FLEET_ALLOW_SUBAGENTS:-0}" != 1 ] || exit 0
  # A LEAF's subagents are its own business: fleet-spawn refuses from a linked worktree,
  # so there is nothing to redirect it to. Refusing here would leave a worker with no
  # way to fan out at all, which is a worse fleet than the one this guard is protecting.
  [ "$_gd" = "$_gcd" ] || exit 0
  # Read-only research passes. These gather and return; they do not build, they leave
  # no branch and no worktree, and no fleet-spawn is shaped like them. Anything else —
  # including the default, unnamed type — is dispatch.
  case "$SUBAGENT" in Explore|Plan) exit 0 ;; esac
  { echo "ghostfleet: dispatch through the fleet, not a Claude subagent."
    echo "  A subagent runs INSIDE this conversation, so the fleet cannot see it: no row in"
    echo "  fleet-list, no 'done' in fleet-inbox, nothing in fleet-worktrees, and the"
    echo "  governor — which parks SESSIONS — cannot shed its usage when the account"
    echo "  tightens. It WORKS, which is exactly why it goes unnoticed; what is lost is"
    echo "  every handle the fleet has on the work you just started."
    echo
    echo "  Hand it to a worker — you keep this thread and can keep working:"
    echo "      fleet-worktrees                                    # REUSE BEFORE PROLIFERATE"
    echo "      fleet-spawn <name> --reuse <worktree> --prompt \"…\""
    echo "      fleet-spawn <name> --branch <b> --from origin/staging --new --prompt \"…\""
    echo "  or the MCP tool: fleet_spawn with name/branch/prompt."
    echo
    echo "  Small enough to just do? Do it here — that needs no worker at all."
    echo
    echo "  Read-only research is NOT blocked: subagent_type Explore or Plan."
    echo "  Deliberate override: CLAUDE_FLEET_ALLOW_SUBAGENTS=1"; } >&2
  exit 2
fi

# ── EnterWorktree ────────────────────────────────────────────────────────────
[ "${CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE:-0}" != 1 ] || exit 0
{ echo "ghostfleet: EnterWorktree is the WRONG tool in a fleet session."
  echo "  It would create <repo>/.claude/worktrees/… and MOVE THIS SESSION into it —"
  echo "  leaving the thread you are talking to somewhere else. ghostfleet worktrees are"
  echo "  siblings of the repo, and a worker is a NEW session; you keep yours."
  echo
  if [ "$_gd" != "$_gcd" ]; then
    echo "  You are already IN a worktree ($GITROOT, branch $_br) — you are a worker, a leaf."
    echo "  Start fresh work where you stand; no new worktree, no new session:"
    echo "      git fetch origin && git checkout -B <new-branch> origin/staging"
  else
    echo "  Hand the work to a worker instead (you keep this thread and can keep working):"
    echo "      fleet-spawn <name> --branch <branch> --from origin/staging --prompt \"…\""
    echo "  or the MCP tool: fleet_spawn with name/branch/prompt."
    echo "  REUSE BEFORE PROLIFERATE — check 'fleet-worktrees' for a free one first."
    echo
    echo "  Doing it yourself, right here, is also fine — that needs no worktree at all:"
    echo "      git checkout -b <branch> && …"
  fi
  echo
  echo "  Deliberate override: CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1"; } >&2
exit 2
