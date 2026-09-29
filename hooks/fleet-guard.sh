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
#   - a LEAF passes, and a leaf is now a SUB-WORKER: a session that is itself somebody's
#     child (<sock>.<name>.parent). It cannot spawn — exactly two levels — so it has no
#     fleet-spawn alternative and its subagents are its own business. A worker that is NOT
#     a child is a potential sub-lead: fleet-spawn from its worktree makes a child of it,
#     so it is redirected there exactly like a top lead. That exemption used to cover
#     every linked worktree, and it is what let a worker running a team of its own do it
#     with subagents the fleet could not see.
#   - CLAUDE_FLEET_ALLOW_SUBAGENTS=1 overrides
#
# THE THIRD: a worker merging its own PR.
#
# The lead scans a worker's PR and merges it; the worker opens it and ends its turn. That
# lived in the brief and nowhere else, and a brief is a thing a worker can talk itself
# past: one finished, saw a green check, and ran `gh pr merge` on its own PR. So the
# refusal sits in front of the tool, like the two above:
#   - a Bash command that merges a PR — `gh pr merge` (with --auto too: that is a merge
#     scheduled for later), `gh api …/pulls/N/merge`, a GraphQL mergePullRequest — and the
#     GitHub MCP server's merge_pull_request tool
#   - ONLY from a session in a LINKED worktree, judged from the directory it was started in
#     ($CLAUDE_PROJECT_DIR) as well as the one it is in now, so a `cd` into the main
#     checkout is not a way round it. The lead in the main checkout is untouched.
#   - a SETTING, "workers can merge", off by default: on for a project, or for the one
#     session that is the sub-master of its task (lib/boundary.sh). Some fleets run workers
#     that legitimately merge their own work. What a worker may NOT do is turn it on: a
#     `fleet-project set` or a write to a boundary marker from a linked worktree is refused
#     too, since an escape hatch a worker can be talked into is the brief again.
# Not a sandbox: a worker that writes the merge into a script and runs the script is not
# caught here. It is the line that makes "I will just merge it" a refused tool call with
# the rule in the reason, rather than a habit.

# Route by the LIVE tmux server, not a possibly-stale CLAUDE_FLEET_SOCK — same
# reasoning as fleet-event.sh: a --resume/--fork Claude can carry an old env var.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

# Never break a session over a missing dependency or an unreadable payload.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
# EVERY Bash call in every session comes through here now, and almost none is a merge:
# leave before jq when the payload cannot be one. A payload this glob misses (other JSON
# spacing) just takes the slow path below; it cannot be let through by it.
case "$input" in *'"tool_name":"Bash"'*) case "$input" in *[Mm]erge*|*agents-approve*|*fleet-project*) ;; *) exit 0 ;; esac ;; esac
MERGE=0
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
case "$TOOL" in EnterWorktree|Agent|Task) ;; Bash|mcp__*__merge_pull_request) MERGE=1 ;; *) exit 0 ;; esac

CWD="${CWD:-$PWD}"
GITROOT="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$GITROOT" ] || exit 0                      # not a repo — nothing to redirect to

# ── am I somewhere this advice applies? ───────────────────────────────────────
# This used to be one line — `[ -n "$CLAUDE_FLEET_SOCK" ] || exit 0`, on the reasoning
# that a plain session outside a fleet keeps the built-in because there is no fleet to
# confuse. MEASURED WRONG: a lead in a registered a registered project's main checkout dispatched a
# general-purpose subagent and was not refused, because it had been started as a plain
# `claude` in that directory rather than through the fleet. The project had five live
# workers at the time. The advice was declined exactly where it was most needed — the
# session could not see the fleet, so neither could the guard.
#
# So the question is no longer "am I inside a fleet" but "is there a fleet here to use".
# Two conditions, and BOTH are required, because a refusal with no alternative is the
# mistake this file already warns about for leaves:
#   1. this checkout belongs to a REGISTERED project, and
#   2. that project has a LIVE tmux server, since fleet-spawn refuses without a socket.
# If either fails there is genuinely nothing to redirect to and the built-in is right.
registered_project() {                 # $1 = a git toplevel -> the project name, or nothing
  local me="${1%/}" cfg name root
  for cfg in "$HOME/.config/ghostfleet/projects" "$HOME/.config/ghostfleet"/projects.*; do
    [ -f "$cfg" ] || continue
    # awk to \x1f and THEN read: a tab is IFS-whitespace, so `IFS=$'\t' read` collapses an
    # empty profile column and shifts root into it. The trap CLAUDE.md opens with.
    while IFS=$'\x1f' read -r name root; do
      [ -n "$name" ] && [ -n "$root" ] || continue
      root="${root/#\~/$HOME}"; root="${root%/}"
      # PHYSICAL PATHS ON BOTH SIDES. git rev-parse hands back the resolved path, and a
      # registered root can be a symlinked one — /var is a symlink to /private/var here, and
      # /tmp to /private/tmp — so a string compare silently never matches. Caught by the
      # first test written against a mktemp fixture, which is exactly where it hides; the
      # same trap fleet-slot documents about a config key written from $PWD.
      [ -d "$root" ] && root="$(cd "$root" 2>/dev/null && pwd -P)" || root="${root}"
      [ -n "$root" ] || continue
      [ "$me" = "$root" ] && { printf '%s' "$name"; return 0; }
      # under it, with the slash required: root /a/b must not match a checkout at /a/bc
      case "$me" in "$root"/*) printf '%s' "$name"; return 0 ;; esac
    done < <(awk -F'\t' '/^[[:space:]]*#/ || NF<2 { next } { printf "%s\x1f%s\n", $1, $2 }' "$cfg" 2>/dev/null)
  done
  return 1
}
OUTSIDE=0; PROJ=""
if [ -z "${CLAUDE_FLEET_SOCK:-}" ]; then
  command -v tmux >/dev/null 2>&1 || exit 0
  PROJ="$(registered_project "$GITROOT")" || exit 0
  [ -n "$PROJ" ] || exit 0
  tmux -L "cf-$PROJ" list-sessions >/dev/null 2>&1 || exit 0
  OUTSIDE=1
fi

# ── a worker does not merge its own PR ──────────────────────────────────────
is_linked() {                          # $1 = a directory -> 0 when it is a LINKED worktree
  [ -n "$1" ] && [ -d "$1" ] || return 1
  local gd gcd
  gd="$(git -C "$1" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || return 1
  gcd="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$gd" ] && [ "$gd" != "$gcd" ]
}
merges_a_pr() {                        # the Bash command on stdin merges a pull request
  # Whitespace folded first, so a merge split across lines is still one.
  tr '\n\t' '  ' | grep -Eq \
    -e '(^|[^[:alnum:]_.-])gh[[:space:]]([^|;&]*[[:space:]])?pr[[:space:]]+merge([[:space:]]|$)' \
    -e '(^|[^[:alnum:]_.-])gh[[:space:]]([^|;&]*[[:space:]])?api[[:space:]][^|;&]*pulls/[^[:space:]/]+/merge' \
    -e 'mergePullRequest|enablePullRequestAutoMerge'
}
# A SETTING, NOT A HARD BLOCK: "workers can merge" (lib/boundary.sh), off by default, on per
# project or for one sub-master session. And a worker may not flip it — for itself or a
# sibling — because a boundary the bounded session can lift is the brief again.
changes_a_boundary() {                 # the Bash command on stdin writes a boundary setting
  tr '\n\t' '  ' | grep -Eq \
    -e '(^|[^[:alnum:]_.-])fleet-project[[:space:]]+set([[:space:]]|$)' \
    -e '\.(workers-merge|agents-approve)(-off)?([^[:alnum:]_-]|$)'
}
if [ "$MERGE" = 1 ]; then
  _cmd=""
  [ "$TOOL" = Bash ] && _cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)"
  _kind=""
  if [ "$TOOL" != Bash ] || merges_a_pr <<< "$_cmd"; then _kind=merge
  elif changes_a_boundary <<< "$_cmd"; then _kind=setting
  else exit 0; fi
  _where=""
  is_linked "$CWD" && _where="$CWD"
  [ -z "$_where" ] && is_linked "${CLAUDE_PROJECT_DIR:-}" && _where="$CLAUDE_PROJECT_DIR"
  [ -n "$_where" ] || exit 0                   # the main checkout: the lead merges, so it may
  _wb="$(git -C "$_where" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$_kind" = setting ]; then
    { echo "ghostfleet: a worker does not change its own boundaries."
      echo "  \"workers can merge\" and \"agents can approve tool calls\" are set by the lead (from the"
      echo "  main checkout) or a human (the grid's , page) — never by a session in a linked worktree,"
      echo "  which is the session they bound. Ask the lead if your task needs one."; } >&2
    exit 2
  fi
  # Is it allowed here? The session's own override first, then its project.
  _bsock="${CLAUDE_FLEET_SOCK:-}"; [ -n "$_bsock" ] || _bsock="cf-$PROJ"
  _bdir="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
  _bsess="$(tmux -L "$_bsock" display-message -p -t "${TMUX_PANE:-}" '#{session_name}' 2>/dev/null)"
  [ -n "$_bsess" ] || _bsess="${CLAUDE_FLEET_SLOT:-}"
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib/boundary.sh" 2>/dev/null \
    && boundary_on workers-merge "$_bdir" "$_bsock" "$_bsess" && exit 0
  # ── A SUB-LEAD MERGES ITS CHILDREN'S PRs INTO ITS OWN BRANCH ────────────────
  # Nested leads (bin/fleet-spawn): a worker's children branch from its branch and PR into
  # it, and nobody but the sub-lead integrates them — so with "workers can merge" off, that
  # one merge is still allowed. Exactly that shape: the PR's BASE is this session's own
  # branch AND its HEAD is one of this session's children's branches. Its own PR upward (base
  # = the integration branch), a stranger's PR into its branch, a sub-worker (which has a
  # parent) and a worker with no children all fall through to the refusal below. A
  # per-session "-off" still vetoes, as it does the setting. The base and head are asked of
  # GitHub (`gh pr view`), bounded, and any failure to learn them refuses.
  if [ -n "$_bsess" ] && [ -n "$_wb" ] && [ ! -f "$_bdir/$_bsock.$_bsess.parent" ] \
     && [ ! -f "$_bdir/$_bsock.$_bsess.workers-merge-off" ]; then
    _kids=""
    for _pt in "$_bdir/$_bsock".*.parent; do
      [ -f "$_pt" ] && [ "$(head -1 "$_pt" 2>/dev/null)" = "$_bsess" ] || continue
      _k="${_pt#"$_bdir/$_bsock."}"; _kids="$_kids ${_k%.parent}"
    done
    if [ -n "$_kids" ]; then
      _kbr=""                                  # the children's branches: manifest, then pane
      for _k in $_kids; do
        _b="$(awk -F'\t' -v s="$_k" '$2==s{print $3; exit}' "$_bdir/$_bsock.manifest.tsv" 2>/dev/null)"
        [ -n "$_b" ] || _b="$(git -C "$(tmux -L "$_bsock" display-message -p -t "$_k" '#{pane_current_path}' 2>/dev/null)" \
                               rev-parse --abbrev-ref HEAD 2>/dev/null)"
        [ -n "$_b" ] && _kbr="$_kbr $_b"
      done
      # WHICH PR. The MCP tool names it; a REST call carries it in the path; `gh pr merge`
      # takes it as the first bare word after `merge` — and with none, the current branch's
      # PR, which is this sub-lead's own one upward and resolves to a base that is refused.
      _sel=""; _repo=""
      if [ "$TOOL" != Bash ]; then
        _sel="$(printf '%s' "$input" | jq -r '.tool_input.pullNumber // .tool_input.pull_number // ""' 2>/dev/null)"
      else
        _flat="$(printf '%s' "$_cmd" | tr '\n\t' '  ')"
        _sel="$(sed -nE 's#.*pulls/([0-9]+)/merge.*#\1#p' <<< "$_flat")"
        [ -n "$_sel" ] || _sel="$(awk '{ for (i=1;i<NF;i++) if ($i=="merge" && $(i-1)=="pr") { for (j=i+1;j<=NF;j++) { if ($j ~ /^[;&|]/) exit; if ($j !~ /^-/) { print $j; exit } } exit } }' <<< "$_flat")"
        _repo="$(sed -nE 's#.*(-R|--repo)[ =]([^ ]+).*#\2#p' <<< "$_flat")"
      fi
      _to=(); command -v timeout >/dev/null 2>&1 && _to=(timeout 15)   # GNU; not on every Mac
      _bh="$( cd "$_where" 2>/dev/null && ${_to[@]+"${_to[@]}"} gh pr view ${_sel:+"$_sel"} ${_repo:+-R "$_repo"} \
                --json baseRefName,headRefName -q '.baseRefName + "\t" + .headRefName' 2>/dev/null )"
      _base="${_bh%%$'\t'*}"; _head="${_bh#*$'\t'}"
      if [ -n "$_bh" ] && [ "$_base" = "$_wb" ] && [ "$_head" != "$_bh" ] \
         && case " $_kbr " in *" $_head "*) true ;; *) false ;; esac; then
        exit 0
      fi
    fi
  fi
  { echo "ghostfleet: a worker does not merge its own PR — the LEAD merges."
    echo "  This session runs in a linked worktree ($_where${_wb:+, branch $_wb}), which makes"
    echo "  it a worker. The lead scans what you opened and merges it from the main checkout;"
    echo "  a green check is its signal to look, not yours to merge."
    echo
    echo "  What to do instead: push, make sure the PR is open against the integration branch,"
    echo "  report the PR number, and end your turn."
    echo
    if command -v boundary_how >/dev/null 2>&1; then boundary_how workers-merge "$_bsock" "$_bsess" | sed 's/^/  /'
    else echo "  Allowed only when the setting \"workers can merge\" (workers-merge) is on."; fi; } >&2
  exit 2
fi

# Which advice applies turns on whether this session is a lead or already a leaf.
# A linked worktree has its own git-dir under the shared common dir; in the main
# checkout the two are the same path. Exact, unlike guessing from the folder name
# (the same test fleet-spawn uses).
_gd="$(git -C "$CWD" rev-parse --git-dir 2>/dev/null)"
_gcd="$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null)"
_br="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
# Is this session a SUB-WORKER — somebody's child? Its name is asked the way fleet-stop
# asks: the pane first (a renamed session keeps its launch-time env), then the env.
_me=""
case "${TMUX:-}" in *"/${CLAUDE_FLEET_SOCK:-/},"*)
  [ -n "${TMUX_PANE:-}" ] && _me="$(tmux -L "$CLAUDE_FLEET_SOCK" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" ;; esac
[ -n "$_me" ] || _me="${CLAUDE_FLEET_SLOT:-}"
_fdir="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
SUBWORKER=0
[ -n "$_me" ] && [ -n "${CLAUDE_FLEET_SOCK:-}" ] && [ -f "$_fdir/$CLAUDE_FLEET_SOCK.$_me.parent" ] && SUBWORKER=1

# ── the Agent tool: dispatch belongs to the fleet ─────────────────────────────
# Placed before the EnterWorktree message rather than beside it: the two share the
# lead/leaf test above and nothing else, and interleaving them would put one tool's
# escape hatch in the other's path.
if [ "$TOOL" != "EnterWorktree" ]; then
  [ "${CLAUDE_FLEET_ALLOW_SUBAGENTS:-0}" != 1 ] || exit 0
  # A LEAF's subagents are its own business — and the leaf is a SUB-WORKER, which cannot
  # spawn, so there is nothing to redirect it to. Refusing it would leave it no way to fan
  # out at all, which is a worse fleet than the one this guard is protecting. Outside the
  # fleet a linked worktree has no session for fleet-spawn to make a child OF, so the same.
  if [ "$_gd" != "$_gcd" ]; then
    [ "$SUBWORKER" = 1 ] && exit 0
    [ "$OUTSIDE" = 1 ] && exit 0
  fi
  # Read-only research passes. These gather and return; they do not build, they leave
  # no branch and no worktree, and no fleet-spawn is shaped like them. Anything else —
  # including the default, unnamed type — is dispatch.
  case "$SUBAGENT" in Explore|Plan) exit 0 ;; esac
  if [ "$OUTSIDE" = 1 ]; then
    { echo "ghostfleet: this checkout belongs to project '$PROJ', which has a LIVE fleet."
      echo "  This session was not started through it, so a subagent here is invisible to that"
      echo "  fleet: no row in fleet-list, no 'done' in its inbox, and its governor — which parks"
      echo "  SESSIONS when the account tightens — cannot shed usage it cannot see."
      echo
      echo "  Dispatch into the fleet that already exists, naming its socket:"
      echo "      fleet-worktrees -s cf-$PROJ                      # REUSE BEFORE PROLIFERATE"
      echo "      fleet-spawn -s cf-$PROJ <name> --reuse <worktree> --prompt \"…\""
      echo "      fleet-spawn -s cf-$PROJ <name> --branch <b> --from origin/main --new --prompt \"…\""
      echo "  The -s is needed because this session has no socket of its own to inherit."
      echo
      echo "  Or work in the fleet instead of beside it:  ghostfleet $PROJ"
      echo
      echo "  Small enough to just do? Do it here — that needs no worker at all."
      echo "  Read-only research is NOT blocked: subagent_type Explore or Plan."
      echo "  Deliberate override: CLAUDE_FLEET_ALLOW_SUBAGENTS=1"; } >&2
    exit 2
  fi
  if [ "$_gd" != "$_gcd" ]; then
    { echo "ghostfleet: dispatch through the fleet, not a Claude subagent — you can run workers too."
      echo "  You are a worker in a worktree ($GITROOT, branch $_br). A fleet-spawn from HERE makes a"
      echo "  CHILD of this session: branched from $_br, its PR into $_br, its done and need-you"
      echo "  in YOUR inbox. A subagent gives you none of that, and the fleet cannot see it."
      echo
      echo "      fleet-spawn <name> --prompt \"…\"          # or the MCP tool fleet_spawn"
      echo "      fleet-inbox                                # your workers' events"
      echo
      echo "  Merge each child's PR into $_br, then open ONE PR from $_br to the integration branch."
      echo "  Small enough to just do? Do it here — that needs no worker at all."
      echo "  Read-only research is NOT blocked: subagent_type Explore or Plan."
      echo "  Deliberate override: CLAUDE_FLEET_ALLOW_SUBAGENTS=1"; } >&2
    exit 2
  fi
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
if [ "$OUTSIDE" = 1 ]; then
  { echo "ghostfleet: this checkout belongs to project '$PROJ', which has a LIVE fleet."
    echo "  EnterWorktree would create <repo>/.claude/worktrees/… and MOVE THIS SESSION into it,"
    echo "  leaving the thread you are talking to somewhere else — and that tree would be"
    echo "  invisible to the fleet beside it: nothing in fleet-worktrees, no slot, no manifest."
    echo
    echo "  Hand it to that fleet instead, naming its socket:"
    echo "      fleet-spawn -s cf-$PROJ <name> --branch <branch> --from origin/main --prompt \"…\""
    echo "  or work inside it:  ghostfleet $PROJ"
    echo
    echo "  Doing it yourself, right here, is also fine — that needs no worktree at all:"
    echo "      git checkout -b <branch> && …"
    echo
    echo "  Deliberate override: CLAUDE_FLEET_ALLOW_BUILTIN_WORKTREE=1"; } >&2
  exit 2
fi
{ echo "ghostfleet: EnterWorktree is the WRONG tool in a fleet session."
  echo "  It would create <repo>/.claude/worktrees/… and MOVE THIS SESSION into it —"
  echo "  leaving the thread you are talking to somewhere else. ghostfleet worktrees are"
  echo "  siblings of the repo, and a worker is a NEW session; you keep yours."
  echo
  if [ "$_gd" != "$_gcd" ]; then
    echo "  You are already IN a worktree ($GITROOT, branch $_br) — you are a worker."
    echo "  Start fresh work where you stand; no new worktree, no new session:"
    echo "      git fetch origin && git checkout -B <new-branch> origin/staging"
    if [ "$SUBWORKER" != 1 ]; then
      echo "  Parallel work under you? fleet-spawn <name> --prompt \"…\" from here makes a child"
      echo "  of this session, on $_br."
    fi
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
