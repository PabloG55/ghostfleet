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
#
# THE FOURTH: a merge with no review behind it (the REVIEW GATE, lib/review-gate.sh).
#
# Off by default, and with it off nothing below changes — the check costs one glob for a
# marker and returns. On, it binds EVERY session, the lead in the main checkout included:
# a merge (any of the forms above, --match-head-commit too) is let through only when the
# PR's CURRENT head commit, asked of GitHub, has a pass recorded by `fleet-review`. A push
# after the review moves the head and voids it. Whose setting decides is the PR's AUTHOR's —
# its head branch, through the manifest, names the session — so a worker switched off for
# itself is not stranded behind a refusal its contract never told it about; a PR no session
# owns falls back to the merging session's, which is the project's unless overridden.
# Refused while it is on: `--auto` (it lands whatever the head is when checks finish, which
# a pass at today's head does not cover) and a GraphQL merge (its PR id cannot be resolved
# here). And no session — the lead included — switches it OFF or writes a review record by
# hand: a line the bound session can lift is the brief again. A human does that.

# Route by the LIVE tmux server, not a possibly-stale CLAUDE_FLEET_SOCK — same
# reasoning as fleet-event.sh: a --resume/--fork Claude can carry an old env var.
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) CLAUDE_FLEET_SOCK="${_t%%,*}"; CLAUDE_FLEET_SOCK="${CLAUDE_FLEET_SOCK##*/}" ;; esac

# Never break a session over a missing dependency or an unreadable payload.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
# EVERY Bash call in every session comes through here now, and almost none is a merge:
# leave before jq when the payload cannot be one. A payload this glob misses (other JSON
# spacing) just takes the slow path below; it cannot be let through by it.
case "$input" in *'"tool_name":"Bash"'*) case "$input" in *[Mm]erge*|*agents-approve*|*fleet-project*|*review*) ;; *) exit 0 ;; esac ;; esac
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
  tmux -u -L "cf-$PROJ" list-sessions >/dev/null 2>&1 || exit 0
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
# WHAT THE COMMAND RUNS, not what it says. A worker's acknowledgement of a brief about
# merging restates the brief — "I push, the lead runs gh pr merge" — and the patterns below
# read that quoted sentence as a merge: the fleet-ack the contract requires was refused twice
# before a reworded third got through. So the arguments of a messaging command (fleet-ack,
# fleet-send, fleet-ledger, git commit), which reach a file or another session's input box and
# never a shell, are taken out before matching. guard-shape.js whatRuns says the rules; this
# is the same scan, and test/run.sh holds the two to one answer. In short: only a simple
# command whose bare command word is one of those is trimmed; a `$(`, backtick, `<(` or `>(`
# in it keeps the whole of it (the shell runs those inside double quotes too); an
# unterminated quote returns the command unchanged; and `; & | ( )` and NEWLINE end a simple
# command, which is why this runs BEFORE the fold — folded, a merge on the line after an ack
# would become one of the ack's arguments.
what_runs() {
  awk '
  { buf = buf (NR > 1 ? "\n" : "") $0 }
  function endword() { if (inw) { nw++; w[nw] = cur }; cur = ""; inw = 0 }
  function trimmed(   i, j, c) {
    if (raw ~ /\$\(|`|[<>]\(/) return raw
    i = 1
    while (i <= nw && w[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) i++
    c = (i <= nw) ? w[i] : ""          # w[] keeps the last segment past nw
    if (c == "fleet-ack" || c == "fleet-send" || c == "fleet-ledger") return " " c " "
    if (c == "git") {
      for (j = i + 1; j <= nw; j++) {
        if (w[j] == "-C" || w[j] == "-c") { j++; continue }
        if (substr(w[j], 1, 1) == "-") continue
        if (w[j] == "commit") return " git commit "
        break
      }
    }
    return raw
  }
  function endseg(op) { endword(); out = out trimmed() op; raw = ""; nw = 0 }
  END {
    s = buf; n = length(s); out = ""; raw = ""; nw = 0; cur = ""; inw = 0
    Q = sprintf("%c", 39); BS = "\\"
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1); d = substr(s, i + 1, 1)
      if (c == Q || (c == "$" && d == Q)) {
        ansi = (c == "$"); j = i + (ansi ? 2 : 1); t = ""
        while (j <= n && substr(s, j, 1) != Q) {
          if (ansi && substr(s, j, 1) == BS && j < n) j++
          t = t substr(s, j, 1); j++
        }
        if (j > n) { printf "%s", s; exit }
        raw = raw substr(s, i, j - i + 1); cur = cur t; inw = 1; i = j; continue
      }
      if (c == "\"") {
        j = i + 1; t = ""
        while (j <= n && substr(s, j, 1) != "\"") {
          if (substr(s, j, 1) == BS && j < n) j++
          t = t substr(s, j, 1); j++
        }
        if (j > n) { printf "%s", s; exit }
        raw = raw substr(s, i, j - i + 1); cur = cur t; inw = 1; i = j; continue
      }
      if (c == BS) {
        if (i >= n) { printf "%s", s; exit }
        raw = raw c d
        if (d != "\n") { cur = cur d; inw = 1 }
        i++; continue
      }
      if ((c == "$" || c == "<" || c == ">") && d == "(") {
        raw = raw c d; cur = cur c d; inw = 1; i++; continue
      }
      if (index(";&|()\n", c)) { endseg(c); continue }
      raw = raw c
      if (c == " " || c == "\t") { endword(); continue }
      cur = cur c; inw = 1
    }
    endseg("")
    printf "%s", out
  }'
}
merges_a_pr() {                        # the Bash command on stdin merges a pull request
  # Whitespace folded first, so a merge split across lines is still one.
  what_runs | tr '\n\t' '  ' | grep -Eq \
    -e '(^|[^[:alnum:]_.-])gh[[:space:]]([^|;&]*[[:space:]])?pr[[:space:]]+merge([[:space:]]|$)' \
    -e '(^|[^[:alnum:]_.-])gh[[:space:]]([^|;&]*[[:space:]])?api[[:space:]][^|;&]*pulls/[^[:space:]/]+/merge' \
    -e 'mergePullRequest|enablePullRequestAutoMerge'
}
# A SETTING, NOT A HARD BLOCK: "workers can merge" (lib/boundary.sh), off by default, on per
# project or for one sub-master session. And a worker may not flip it — for itself or a
# sibling — because a boundary the bounded session can lift is the brief again.
changes_a_boundary() {                 # the Bash command on stdin writes a boundary setting
  what_runs | tr '\n\t' '  ' | grep -Eq \
    -e '(^|[^[:alnum:]_.-])fleet-project[[:space:]]+set([[:space:]]|$)' \
    -e '\.(workers-merge|agents-approve|review-gate)(-off)?([^[:alnum:]_-]|$)' \
    -e '\.reviews(/|[^[:alnum:]_-]|$)'
}
# THE REVIEW GATE IS LIFTED by nobody in a session — the lead included, since it binds the
# lead's merges too. Switching it off or to inherit, an -off marker, removing the project's
# marker, and any write into the review records (fleet-review is their one writer). Reads
# of the markers and records are not writes and are let through.
lifts_review_gate() {                  # the Bash command on stdin lifts the review gate
  what_runs | tr '\n\t' '  ' | grep -Eq \
    -e '(^|[^[:alnum:]_.-])fleet-project[[:space:]]+set[[:space:]]([^|;&]*[[:space:]])?review-gate[[:space:]]+(off|inherit)([[:space:]]|$)' \
    -e '\.review-gate-off([^[:alnum:]_-]|$)' \
    -e '(^|[[:space:];&|(])(rm|mv|unlink)[[:space:]][^|;&]*\.review-gate([^[:alnum:]_-]|$)' \
    -e '(^|[[:space:];&|(])(rm|mv|cp|tee|touch|ln|truncate|unlink)[[:space:]][^|;&]*\.reviews(/|[^[:alnum:]_-]|$)' \
    -e '>[[:space:]]*[^[:space:]|;&]*\.reviews(/|[^[:alnum:]_-]|$)' \
    -e '(^|[[:space:];&|(])(sed|perl)[[:space:]][^|;&]*-[A-Za-z]*i[^|;&]*\.reviews/'
}
# WHICH PR A MERGE NAMES, as words rather than a regex over the line: a --subject "two
# words" or a --match-head-commit <sha> put bare words after `merge` that are not the PR.
# Sets _sel (number, URL or branch; empty = the current branch's PR), _repo, _mhc (the
# --match-head-commit value) and _auto. xargs does the shell's quote-splitting.
merge_target() {                       # $1 = the Bash command
  local flat seg w want="" seen_pr=0 in_merge=0
  _sel=""; _repo=""; _mhc=""; _auto=0
  flat="$(printf '%s' "$1" | tr '\n\t' '  ')"
  seg="$(sed -nE 's/.*(^|[^[:alnum:]_.-])(gh[[:space:]]([^|;&]*[[:space:]])?pr[[:space:]]+merge([[:space:]][^|;&]*)?).*/\2/p' <<< "$flat")"
  [ -n "$seg" ] || return 0
  while IFS= read -r w; do
    if [ -n "$want" ]; then
      case "$want" in repo) _repo="$w" ;; mhc) _mhc="$w" ;; esac; want=""; continue
    fi
    case "$w" in
      -R|--repo) want=repo; continue ;;
      --repo=*) _repo="${w#--repo=}"; continue ;;
      --match-head-commit) want=mhc; continue ;;
      --match-head-commit=*) _mhc="${w#*=}"; continue ;;
      --auto) _auto=1; continue ;;
      -t|--subject|-b|--body|-F|--body-file|-A|--author-email) want=skip; continue ;;
    esac
    [ "$w" = pr ] && [ "$in_merge" = 0 ] && { seen_pr=1; continue; }
    [ "$w" = merge ] && [ "$seen_pr" = 1 ] && [ "$in_merge" = 0 ] && { in_merge=1; continue; }
    [ "$in_merge" = 1 ] || continue
    case "$w" in -*) continue ;; esac
    [ -z "$_sel" ] && _sel="$w"
  done < <(xargs -n1 printf '%s\n' <<< "$seg" 2>/dev/null)
  return 0
}
_gate_refuse() {                       # $1 = the reason line; the rest is the same every time
  { echo "ghostfleet: the review gate is on — $1"
    [ -n "${2:-}" ] && echo "  $2"
    echo
    echo "  \"review gate\" (review-gate) is on here: no session, the lead included, merges a PR until"
    echo "  an independent review has passed at the PR's CURRENT head commit. A push after the review"
    echo "  moves the head and voids it."
    echo
    echo "  What to do instead: the session that owns the PR${_gowner:+ ($_gowner)} runs the review loop its"
    echo "  contract describes — a reviewer subagent, then fleet-review round ${_gnum:-<pr>} — until it"
    echo "  says PASS. Then merge, with --match-head-commit <that head> to pin it."
    echo "      fleet-review status ${_gnum:-<pr>}        # the rounds so far, and whether the head is passed"
    echo "  Only a human turns the gate off (fleet-project set -s $_bsock review-gate off in their own"
    echo "  terminal, or the grid's , page)."; } >&2
  exit 2
}
# review_gate_check — returns when the merge may go on; exits 2 when it may not.
review_gate_check() {
  review_gate_anywhere "$_bdir" "$_bsock" || return 0
  _gowner=""; _gnum=""
  local info num url head hbranch key rec lp
  if [ "$TOOL" != Bash ]; then
    _sel="$(printf '%s' "$input" | jq -r '.tool_input.pullNumber // .tool_input.pull_number // ""' 2>/dev/null)"
    _repo="$(printf '%s' "$input" | jq -r 'if (.tool_input.owner // "") != "" and (.tool_input.repo // "") != "" then .tool_input.owner + "/" + .tool_input.repo else "" end' 2>/dev/null)"
    _mhc="$(printf '%s' "$input" | jq -r '.tool_input.sha // ""' 2>/dev/null)"; _auto=0
  else
    _flat="$(printf '%s' "$_cmd" | tr '\n\t' '  ')"
    if grep -Eq 'pulls/[^[:space:]/]+/merge' <<< "$_flat"; then
      _sel="$(sed -nE 's#.*pulls/([0-9]+)/merge.*#\1#p' <<< "$_flat")"
      _repo="$(sed -nE 's#.*repos/([^/[:space:]]+/[^/[:space:]]+)/pulls/.*#\1#p' <<< "$_flat")"
      _mhc="$(sed -nE 's#.*[[:space:]]-[fF][[:space:]]+sha=([0-9a-fA-F]+).*#\1#p' <<< "$_flat")"; _auto=0
    elif grep -Eq 'mergePullRequest|enablePullRequestAutoMerge' <<< "$_flat"; then
      _gate_refuse "a GraphQL merge names its PR by node id, which cannot be checked against a review here." \
                   "Use gh pr merge <number> instead."
    else
      merge_target "$_cmd"
    fi
  fi
  if [ "$_auto" = 1 ]; then
    _gate_refuse "--auto schedules a merge of whatever the head is when the checks finish, and a pass covers" \
                 "one head. Merge the reviewed head now instead, with --match-head-commit."
  fi
  local to=(); command -v timeout >/dev/null 2>&1 && to=(timeout 15)
  info="$( cd "${_where:-$CWD}" 2>/dev/null && ${to[@]+"${to[@]}"} gh pr view ${_sel:+"$_sel"} ${_repo:+-R "$_repo"} \
             --json number,url,headRefOid,headRefName \
             -q '[(.number|tostring), .url, .headRefOid, .headRefName] | join("\t")' 2>/dev/null )"
  IFS=$'\t' read -r num url head hbranch <<< "$info"
  _gnum="$num"
  if [ -z "$head" ] || ! key="$(review_key "$url")"; then
    _gate_refuse "could not learn the PR's head commit from GitHub (gh pr view${_sel:+ $_sel})," \
                 "and with the gate on a merge that cannot be checked is refused, not let through."
  fi
  # The author's setting, by head branch: the manifest (fleet-spawn), then the pane of a live
  # session on this socket whose checkout is on that branch is not asked — too slow for a hook.
  _gowner="$(awk -F'\t' -v b="$hbranch" '$3 == b { print $2; exit }' "$_bdir/$_bsock.manifest.tsv" 2>/dev/null)"
  review_gate_on "$_bdir" "$_bsock" "${_gowner:-$_bsess}" || return 0
  if [ -n "$_mhc" ]; then
    case "$head" in "$_mhc"*) ;; *)
      _gate_refuse "--match-head-commit names ${_mhc:0:7}, but PR #$num's head is ${head:0:7}." ;; esac
  fi
  rec="$(review_file "$_bdir" "$_bsock" "$key")"
  review_passed_at "$rec" "$head" && return 0
  lp="$(review_last_pass "$rec")"
  if [ -n "$lp" ]; then
    _gate_refuse "PR #$num has no passing review at its head ${head:0:7}." \
                 "The last pass was at ${lp:0:7}; the PR has moved since, so it no longer counts."
  fi
  _gate_refuse "PR #$num has no passing review at its head ${head:0:7}." "No review is recorded for this PR."
}
if [ "$MERGE" = 1 ]; then
  _cmd=""
  [ "$TOOL" = Bash ] && _cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)"
  _kind=""
  if [ "$TOOL" = Bash ] && lifts_review_gate <<< "$_cmd"; then _kind=lift
  elif [ "$TOOL" != Bash ] || merges_a_pr <<< "$_cmd"; then _kind=merge
  elif changes_a_boundary <<< "$_cmd"; then _kind=setting
  else exit 0; fi
  # Which fleet, session and settings: the session's own override first, then its project.
  _bsock="${CLAUDE_FLEET_SOCK:-}"; [ -n "$_bsock" ] || _bsock="cf-$PROJ"
  _bdir="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
  _bsess="$(tmux -u -L "$_bsock" display-message -p -t "${TMUX_PANE:-}" '#{session_name}' 2>/dev/null)"
  [ -n "$_bsess" ] || _bsess="${CLAUDE_FLEET_SLOT:-}"
  _blib="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib"
  . "$_blib/boundary.sh" 2>/dev/null; . "$_blib/review-gate.sh" 2>/dev/null
  # No `command -v` fallback that lets it through: a lib that did not load must not turn
  # the gate into nothing, so its absence is treated as "on, unchecked" and refused.
  command -v review_gate_anywhere >/dev/null 2>&1 || review_gate_anywhere() { [ -n "$(ls "$1/$2".review-gate "$1/$2".*.review-gate 2>/dev/null)" ]; }
  if [ "$_kind" = lift ]; then
    { echo "ghostfleet: no session turns the review gate off, or writes a review record by hand."
      echo "  \"review gate\" binds this session's merges too — the lead's included — and a line the"
      echo "  bound session can lift is the brief again. A human switches it off, from their own terminal"
      echo "  or the grid's , page. Review records have one writer: fleet-review round | pass | stuck."; } >&2
    exit 2
  fi
  _where=""
  is_linked "$CWD" && _where="$CWD"
  [ -z "$_where" ] && is_linked "${CLAUDE_PROJECT_DIR:-}" && _where="$CLAUDE_PROJECT_DIR"
  if [ -z "$_where" ]; then                    # the main checkout: the lead merges, so it may —
    [ "$_kind" = merge ] && review_gate_check  # behind the review gate, when that is on
    exit 0
  fi
  _wb="$(git -C "$_where" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$_kind" = setting ]; then
    { echo "ghostfleet: a worker does not change its own boundaries."
      echo "  \"workers can merge\", \"agents can approve tool calls\" and \"review gate\" are set by the lead"
      echo "  (from the main checkout) or a human (the grid's , page) — never by a session in a linked"
      echo "  worktree, which is the session they bound. Ask the lead if your task needs one."; } >&2
    exit 2
  fi
  if command -v boundary_on >/dev/null 2>&1 && boundary_on workers-merge "$_bdir" "$_bsock" "$_bsess"; then
    review_gate_check; exit 0
  fi
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
        [ -n "$_b" ] || _b="$(git -C "$(tmux -u -L "$_bsock" display-message -p -t "$_k" '#{pane_current_path}' 2>/dev/null)" \
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
        review_gate_check; exit 0
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
  [ -n "${TMUX_PANE:-}" ] && _me="$(tmux -u -L "$CLAUDE_FLEET_SOCK" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" ;; esac
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
