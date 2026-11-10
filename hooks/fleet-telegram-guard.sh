#!/usr/bin/env bash
# hooks/fleet-telegram-guard.sh — PreToolUse: a turn the owner started from Telegram runs
# only the tools the channel allows.
#
# THE CHANNEL IS A DOOR INTO A SESSION FROM A PHONE, and the owner decided what may come
# through it: an allowlist, not full power. A Telegram message is words from a device that
# can be lost, borrowed or read over a shoulder, and the session it lands in is usually a
# lead with a shell and a checkout. So the turn it starts may read, search, look things up
# and drive the fleet — answer, delegate, spawn, wake — but not run a shell or write outside
# its own scratch directory, unless the owner named the command or the checkout on the list.
# Delegated work runs in the session it was handed to, with that session's own permissions:
# this is a limit on the turn, not a sandbox, and docs/TELEGRAM.md says so.
#
# WHICH TURN: hooks/fleet-event.sh writes <fleet dir>/<sock>.<slot>.telegram at the
# UserPromptSubmit of a prompt that bin/fleet-telegram delivered, and removes it at that
# turn's Stop. An ARMED reply address to `telegram/…` counts too — that is the same turn
# reached the other way round, and either signal alone holds it.
#
# EVERY TOOL CALL IN EVERY SESSION COMES THROUGH HERE (matcher ""), and almost none is in a
# Telegram turn. So the first question costs no process at all: is there a mark anywhere on
# this socket. Only then is the slot resolved and the payload parsed.
#
# Blocking contract: exit 2, message on stderr — Claude Code hands stderr to the model as
# the reason, so the refusal says what it MAY do instead. codex speaks the same contract
# (hooks/codex-fleet-event.sh hands it every PreToolUse): seen live, a refused exec_command
# failed the script with this message and did not run. What codex does NOT send here is
# write_stdin, typing into a process an earlier turn left running (docs/TELEGRAM.md).
#
#   fleet-telegram-guard.sh                 the hook (payload on stdin)
#   fleet-telegram-guard.sh --list          the effective allowlist, one line, for the context
#                                           fleet-event.sh gives the turn and for fleet-telegram
#   fleet-telegram-guard.sh --notes         what the scoped entries on that list mean, for the
#                                           same context
#   fleet-telegram-guard.sh --default       the built-in list
#   fleet-telegram-guard.sh --checkout-root the root a :checkout entry means; exit 1 when the
#                                           fleet has none on record for this session
#   fleet-telegram-guard.sh --lex <command> what stops that command running under an entry;
#                                           prints nothing when nothing does

FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/fleet}"
TG_DEFAULT_DIR="$HOME/.config/ghostfleet/telegram"

# THE DEFAULT ALLOWLIST. An entry is one of:
#   Read, mcp__x__*     a glob over the tool name
#   Write:scratch       that tool, only for a path inside this session's scratch directory
#   Write:checkout      that tool, only for a path inside this session's checkout
#   Bash(<prefix> *)    Bash, only for that command with any arguments
#   Bash(<command>)     Bash, only for exactly that command
# mcp__ghostfleet__fleet_* is every fleet tool, the ones a lead delegates with (fleet_send,
# fleet_spawn, fleet_wake, fleet_telegram_send) and any added later. No Bash, no Agent/Task,
# no write anywhere else.
DEFAULT_ALLOW=(Read Glob Grep LS NotebookRead WebFetch WebSearch ToolSearch TodoWrite
               'mcp__ghostfleet__fleet_*'
               Write:scratch Edit:scratch MultiEdit:scratch NotebookEdit:scratch)

# Past this a command is refused unread. The lexer is a bash loop over a string, which is
# quadratic: measured on bash 3.2, 16 KB takes a second, 64 KB five and 128 KB eighteen. Only
# exit 2 blocks a call, so a hook still working when its timeout arrives has not refused
# anything, and a command long enough to outlast the check must not be a way past it. A
# Telegram message is at most 4096 characters, so one relayed in quotes fits with room.
CMD_MAX=32768

# Socket and slot the way fleet-event.sh derives them: the live server from $TMUX (an
# exported CLAUDE_FLEET_SOCK can be stale behind a --resume), the slot from the pane's own
# id (a rename cannot reach an exported CLAUDE_FLEET_SLOT).
SOCK="${CLAUDE_FLEET_SOCK:-}"
_t="${TMUX:-}"; case "${_t##*/}" in cf-*) _s="${_t%%,*}"; SOCK="${_s##*/}" ;; esac

slot() {
  local live=""
  if [ -n "${TMUX_PANE:-}" ]; then
    case "${TMUX:-}" in *"/$SOCK,"*)
      live="$(tmux -u -L "$SOCK" display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" ;;
    esac
  fi
  case "$live" in ''|_*|+*) live="${CLAUDE_FLEET_SLOT:-}" ;; esac
  printf '%s' "$live"
}

# The channel's state dir for this turn: what the mark recorded, else the reply address's
# directory, else the default. Its config.json holds the owner's allowlist.
tg_dir() {
  local d="" f1 f3
  [ -f "$FLEET_DIR/$SOCK.$SLOT.telegram" ] && d="$(head -n 1 "$FLEET_DIR/$SOCK.$SLOT.telegram" 2>/dev/null)"
  if [ -z "$d" ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to" ]; then
    IFS=$'\x1f' read -r f1 _ f3 _ < "$FLEET_DIR/$SOCK.$SLOT.reply-to" 2>/dev/null
    [ "${f1:-}" = telegram ] && d="${f3:-}"
  fi
  case "$d" in /*) printf '%s' "$d" ;; *) printf '%s' "$TG_DEFAULT_DIR" ;; esac
}

# The allowlist in force: config.json's "allow" when it is a non-empty array of strings,
# else the default. An unreadable file is the default, never "nothing" and never "all".
ALLOW=()
load_allow() {
  local cfg; cfg="$(tg_dir)/config.json"; ALLOW=()
  if [ -f "$cfg" ] && command -v jq >/dev/null 2>&1; then
    while IFS= read -r line; do [ -n "$line" ] && ALLOW+=("$line"); done < <(
      jq -r 'if (.allow | type) == "array" then .allow[] | strings else empty end' "$cfg" 2>/dev/null)
  fi
  [ "${#ALLOW[@]}" -gt 0 ] || ALLOW=("${DEFAULT_ALLOW[@]}")
}

# THE LEXER, for a command entry. A prefix check alone reads `bin/acme-api x; rm -rf ~` as
# bin/acme-api, so the shell must also be about to see ONE plain command: nothing outside
# quotes that ends it, chains it, redirects it or expands into something else. Prints what
# it refused, and nothing when the command is clean.
#
# `#` IS ON THE LIST BECAUSE OF WHAT THE QUOTES WOULD OTHERWISE HIDE. A shell reads a comment
# to the end of the line and ignores any quote in it, while this lexer would open a quote and
# carry it across the newline, so
#     bin/acme-api # '
#     rm -rf ~
#     # '
# reads here as one command with a quoted argument and runs in bash and zsh alike as three
# lines, the second of them a stranger's. Refusing the `#` keeps the two readings the same,
# and a newline inside real quotes, which a relayed message needs, stays allowed. The cost is
# that `x#y` has to be quoted, which is one retry.
#
# In C locale so this walks bytes: every character it cares about is ASCII, and no byte of a
# UTF-8 sequence can be mistaken for one.
command_problem() {
  local LC_ALL=C
  local s="$1" n="${#1}" i=0 c st=normal
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"; i=$((i + 1))
    case "$st" in
      normal)
        case "$c" in
          \\)
            # Nothing left to make literal: an incomplete word, like an unterminated quote.
            [ "$i" -lt "$n" ] || { printf 'a backslash with nothing after it'; return; }
            # Not a literal newline: the shell deletes both, and the next line joins this one.
            [ "${s:$i:1}" != $'\n' ] || { printf 'a backslash at the end of a line'; return; }
            i=$((i + 1)) ;;
          \') st=single ;;
          \") st=double ;;
          \;|\&|\||\<|\>|\(|\)|\$|\`|\#) printf "an unquoted '%s'" "$c"; return ;;
          $'\n'|$'\r') printf 'a line break outside quotes'; return ;;
        esac ;;
      single)
        [ "$c" != "'" ] || st=normal ;;
      double)
        case "$c" in
          \\) i=$((i + 1)) ;;
          \") st=normal ;;
          \$|\`) printf "a '%s' inside double quotes, which still expands" "$c"; return ;;
        esac ;;
    esac
  done
  [ "$st" = normal ] || printf 'a quote that never closes'
}

# Does this command fit the inside of a Bash(...) entry? Plain string comparison all the way,
# so a `*` or `?` in the entry can never glob: the only `*` that means anything is the
# trailing " *", and the boundary after the prefix is a space, so bin/acme does not reach
# bin/acmex. A command is compared whole and from its first byte, so neither ./bin/acme nor
# FOO=1 bin/acme is bin/acme.
command_fits() {
  local body="$1" cmd="$2"
  case "$body" in
    ''|' *') return 1 ;;
    *' *')
      body="${body% \*}"
      [ "$cmd" != "$body" ] || return 0
      case "$cmd" in "$body "*) return 0 ;; esac
      return 1 ;;
    *) [ "$cmd" = "$body" ] ;;
  esac
}

# Sets RESOLVED to a path with every symlink in it resolved, or returns 1 for one that cannot
# be trusted. The file may not exist yet, so its nearest existing ancestor is resolved and the
# rest appended. `..` and a symlink AT the path are refused outright, and so is one on the way
# up that points nowhere yet: `cd` cannot resolve it, and either can point a write anywhere.
RESOLVED=""
resolve_path() {
  local p="$1" d rest="" real
  case "$p" in /*) ;; *) return 1 ;; esac
  case "/$p/" in */../*|*/./*) return 1 ;; esac
  [ -L "$p" ] && return 1
  d="${p%/*}"; [ -n "$d" ] || d="/"
  while [ ! -d "$d" ]; do
    [ -L "$d" ] && return 1
    rest="/${d##*/}$rest"; d="${d%/*}"; [ -n "$d" ] || d="/"
  done
  real="$(cd "$d" 2>/dev/null && pwd -P)" || return 1
  RESOLVED="${real%/}$rest/${p##*/}"
}

in_scratch() {
  local sr
  mkdir -p "$SCRATCH" 2>/dev/null
  sr="$(cd "$SCRATCH" 2>/dev/null && pwd -P)" || return 1
  resolve_path "$1" || return 1
  case "$RESOLVED" in "$sr"/?*) return 0 ;; esac
  return 1
}

# The tmux session's start directory, one value by an exact name. A record of name and path
# would need a separator, and tmux 3.4 with no UTF-8 locale prints a tab as `_`: the record
# never splits, the session looks unknown, and a worktree worker silently gets the main
# checkout. `=name:` needs none. Measured on 3.4 and 3.7b: the exact session answers, master-2
# does not answer for master, and a name that is no session prints nothing.
session_start_dir() {
  tmux -u -L "$SOCK" display-message -p -t "=$SLOT:" '#{session_path}' 2>/dev/null
}

# Is this physical directory one git itself lists as a worktree of that checkout?
listed_worktree() {
  local line d
  while IFS= read -r line; do
    case "$line" in "worktree "*)
      d="$(cd "${line#worktree }" 2>/dev/null && pwd -P)" && [ "$d" = "$2" ] && return 0 ;;
    esac
  done < <(git -C "$1" worktree list --porcelain 2>/dev/null)
  return 1
}

# THE ROOT A :checkout ENTRY MEANS, from the fleet's records and never from the payload's
# `cwd`, which moves with the agent's `cd`.
#
# THE PROJECTS FILE IS THE ANCHOR: the socket names its project, and no tool call can move it.
# The session's start directory (`#{session_path}`) only narrows that. A worker in its own
# worktree has its worktree as its checkout, so the main checkout is NOT its to write. But the
# start directory is not trusted alone, because a restart recreates a session from wherever
# its pane was, or from $HOME when that is unknown. So a start directory must be the project,
# be inside it, or be a worktree git lists for it; anything else means this session has no
# checkout we can vouch for, and that is a refusal rather than a guess.
#
# $HOME, or anything above it, is never a checkout. A project registered there would hand a
# phone the owner's dotfiles and ~/.ssh under the name of editing a repo.
checkout_root() {
  local rec proj root home start s
  rec="$(node "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib/projects.mjs" sock "$SOCK" 2>/dev/null)" || return 1
  IFS=$'\x1f' read -r _ _ _ proj _ <<< "$rec"
  case "$proj" in /*) ;; *) return 1 ;; esac
  root="$(cd "$proj" 2>/dev/null && pwd -P)" || return 1
  start="$(session_start_dir)"
  if [ -n "$start" ]; then
    s="$(cd "$start" 2>/dev/null && pwd -P)" || return 1
    if [ "$s" != "$root" ]; then
      if listed_worktree "$root" "$s"; then
        root="$s"
      else
        case "$s/" in "$root"/*) ;; *) return 1 ;; esac
      fi
    fi
  fi
  home="$(cd "$HOME" 2>/dev/null && pwd -P)" || return 1
  case "$home/" in "${root%/}"/*) return 1 ;; esac
  printf '%s' "$root"
}

# Asked once a call: the answer costs a node process, and a refusal needs it twice.
CHECKOUT=""; CHECKOUT_ASKED=0
load_checkout() {
  if [ "$CHECKOUT_ASKED" = 0 ]; then
    CHECKOUT="$(checkout_root)" || CHECKOUT=""
    CHECKOUT_ASKED=1
  fi
  [ -n "$CHECKOUT" ]
}

# Inside the checkout, after symlinks, and not in a .git directory. .git is inside the root but
# is not the checkout: it never shows in `git status` or a diff, and it decides what runs. With
# `Bash(git log *)` on the list, a write to .git/config sets diff.external and the next
# `git log -p --ext-diff` runs it, so the two entries together would be a shell. Compared in
# lower case because .GIT/config IS .git/config on a default macOS volume.
in_checkout() {
  local rel
  load_checkout || return 1
  resolve_path "$1" || return 1
  case "$RESOLVED" in "$CHECKOUT"/?*) ;; *) return 1 ;; esac
  rel="$(printf '%s' "${RESOLVED#"$CHECKOUT"/}" | tr '[:upper:]' '[:lower:]')"
  case "/$rel/" in */.git/*) return 1 ;; esac
  return 0
}

# What the scoped entries on this list mean, said only for the ones it has, so a list with no
# command entries does not talk about commands.
scope_notes() {
  local e scr=0 chk=0 cmd=0 out=""
  for e in "${ALLOW[@]}"; do
    case "$e" in
      'Bash('*')') cmd=1 ;;
      *:scratch)   scr=1 ;;
      *:checkout)  chk=1 ;;
    esac
  done
  [ "$scr" = 0 ] || out="A :scratch entry covers files under $SCRATCH/ only."
  if [ "$chk" = 1 ]; then
    if load_checkout; then
      out="${out:+$out }A :checkout entry covers files under $CHECKOUT/ only, and never a .git directory."
    else
      out="${out:+$out }A :checkout entry covers nothing right now: the fleet has no checkout on record for this session."
    fi
  fi
  [ "$cmd" = 0 ] || out="${out:+$out }A Bash(...) entry covers one command: <prefix> * is that prefix as whole words with any arguments, anything else is that exact command. Outside quotes it may not contain ; & | < > ( ) \$ \` # or a line break, so pass text in single quotes, and write a single quote as '\\''."
  printf '%s' "$out"
}

case "${1:-}" in
  --default) printf '%s\n' "${DEFAULT_ALLOW[*]}"; exit 0 ;;
  --list)    SLOT="$(slot)"; load_allow; printf '%s\n' "${ALLOW[*]}"; exit 0 ;;
  --notes)   SLOT="$(slot)"; SCRATCH="$FLEET_DIR/telegram/$SOCK.$SLOT"; load_allow
             scope_notes; printf '\n'; exit 0 ;;
  --checkout-root)
             SLOT="$(slot)"; checkout_root || exit 1; printf '\n'; exit 0 ;;
  --lex)     command_problem "${2:-}"; printf '\n'; exit 0 ;;
esac

input="$(cat)"
[ -n "$SOCK" ] || exit 0
# The free question first: a mark or an armed address anywhere on this socket.
_any=0
for f in "$FLEET_DIR/$SOCK".*.telegram "$FLEET_DIR/$SOCK".*.reply-to.armed; do
  [ -e "$f" ] && { _any=1; break; }
done
[ "$_any" = 1 ] || exit 0

SLOT="$(slot)"
[ -n "$SLOT" ] || exit 0
ACTIVE=0
[ -f "$FLEET_DIR/$SOCK.$SLOT.telegram" ] && ACTIVE=1
if [ "$ACTIVE" = 0 ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to.armed" ] && [ -f "$FLEET_DIR/$SOCK.$SLOT.reply-to" ]; then
  IFS=$'\x1f' read -r _f1 _ < "$FLEET_DIR/$SOCK.$SLOT.reply-to" 2>/dev/null
  [ "${_f1:-}" = telegram ] && ACTIVE=1
fi
[ "$ACTIVE" = 1 ] || exit 0

SCRATCH="$FLEET_DIR/telegram/$SOCK.$SLOT"
refuse() {
  printf '%s\n' "[fleet] This turn came from the owner on Telegram, and $1 Tools this turn may use: ${ALLOW[*]}. $(scope_notes) To get it done anyway, delegate it: fleet_send the task to a session that can do it (fleet_spawn a worker for new work), then tell the owner who has it. Only the owner can widen the list, at the desk: fleet-telegram config allow <tool-pattern>." >&2
  exit 2
}

# No jq is no way to read the call, and this turn is restricted: refuse rather than guess.
if ! command -v jq >/dev/null 2>&1; then
  ALLOW=("${DEFAULT_ALLOW[@]}"); refuse "this machine has no jq, so the call cannot be checked."
fi
load_allow
# THE PATH IS CHECKED ONLY IF IT IS THE ONE THE TOOL WILL USE. A call that carries both path
# fields and has them disagree is checked on one and may write the other, and a control
# character would be flattened below, so what was checked would not be the path either. Both
# leave FPATH empty, which no scope accepts.
IFS=$'\x1f' read -r TOOL FPATH TSESS TPROJ < <(
  printf '%s' "$input" | jq -r '[ (.tool_name // ""),
      ((.tool_input // {}) | [.file_path, .notebook_path] | map(select(. != null)) | unique
        | if length == 1 and (.[0] | type) == "string" and (.[0] | explode | all(. >= 32 and . != 127))
          then .[0] else "" end),
      ((.tool_input // {}) | (.session // "")),
      ((.tool_input // {}) | (.project // "")) ]
    | map(tostring | gsub("[\u001f\n\r]"; " ")) | join("\u001f")' 2>/dev/null)
[ -n "${TOOL:-}" ] || refuse "the call could not be read."

# A FLEET TOOL AIMED AT THIS VERY SESSION is the one way round the list from inside it: a
# prompt it sends itself queues behind this turn and runs, after the Stop, as an ordinary
# turn with every tool. Delegating to ANOTHER session is the point of the channel.
is_self() {
  [ "${TSESS:-}" = "$SLOT" ] || return 1
  case "${TPROJ:-}" in
    ''|"$SOCK"|"cf-$TPROJ") return 0 ;;
  esac
  [ "$SOCK" = "cf-$TPROJ" ] && return 0
  case "$SOCK" in cf-*-"$TPROJ") return 0 ;; esac
  return 1
}
case "$TOOL" in
  mcp__ghostfleet__fleet_send|mcp__ghostfleet__fleet_answer|mcp__ghostfleet__fleet_resume)
    is_self && refuse "$TOOL to this same session ($SLOT) would run that prompt later as a turn the list does not cover." ;;
esac

# THE COMMAND IS READ ON ITS OWN, NOT THROUGH THE RECORD ABOVE. That record turns a newline
# into a space, which would show the lexer `x rm -rf ~` where the shell gets two lines. The
# "." keeps $(…) from eating a trailing newline, and a NUL is refused here because a shell
# variable cannot hold one: the lexer would be reading a different string from the one the
# tool runs. Surrounding spaces and tabs are trimmed, but not newlines, so one at either end
# is still a newline: a leading one fails the prefix and a trailing one fails the lexer.
CMD=""; CMD_BAD=""
if [ "$TOOL" = Bash ]; then
  CMD="$(printf '%s' "$input" | jq -j '(.tool_input // {}).command
          | if type == "string" and (explode | any(. == 0) | not) then ., "." else empty end' 2>/dev/null)"
  if [ -z "$CMD" ]; then
    CMD_BAD="this shell call has no command that can be read."
  elif [ "$(LC_ALL=C; printf '%s' "${#CMD}")" -gt "$CMD_MAX" ]; then
    CMD=""; CMD_BAD="this shell command is over $CMD_MAX bytes, too long to check."
  else
    CMD="${CMD%.}"
    _ws=$' \t'
    CMD="${CMD#"${CMD%%[!$_ws]*}"}"
    CMD="${CMD%"${CMD##*[!$_ws]}"}"
  fi
fi

# EVERY ENTRY GETS ITS SAY. A scoped entry that does not cover this call is not a refusal,
# because a later one may: the default list opens with Write:scratch, so stopping there would
# mean `config allow Write:checkout` (or plain Write) never takes effect. What was refused,
# and why, is kept for the message if nothing allows the call.
WHERE=""; REFUSED=""
for e in "${ALLOW[@]}"; do
  case "$e" in
    'Bash('*')')
      [ "$TOOL" = Bash ] || continue
      if [ -n "$CMD_BAD" ]; then REFUSED="$CMD_BAD"; continue; fi
      body="${e#Bash(}"; body="${body%)}"
      command_fits "$body" "$CMD" || continue
      why="$(command_problem "$CMD")"
      [ -n "$why" ] || exit 0
      REFUSED="this shell command fits $e but contains $why, so a shell would not run it as one plain command."
      continue ;;
    *:scratch)  pat="${e%:scratch}";  scope=scratch ;;
    *:checkout) pat="${e%:checkout}"; scope=checkout ;;
    *)          pat="$e";             scope="" ;;
  esac
  # shellcheck disable=SC2254  # the entry IS a glob
  case "$TOOL" in
    $pat)
      case "$scope" in
        scratch)
          in_scratch "$FPATH" && exit 0
          case "$WHERE" in *"$SCRATCH/"*) ;; *) WHERE="${WHERE:+$WHERE or }$SCRATCH/" ;; esac ;;
        checkout)
          in_checkout "$FPATH" && exit 0
          if load_checkout; then
            case "$WHERE" in *"$CHECKOUT/"*) ;; *) WHERE="${WHERE:+$WHERE or }$CHECKOUT/ (not its .git)" ;; esac
          fi ;;
        *) exit 0 ;;
      esac ;;
  esac
done
[ -z "$WHERE" ] || refuse "$TOOL may write only under $WHERE, and ${FPATH:-this call} is not there."
[ -z "$REFUSED" ] || refuse "$REFUSED"
refuse "$TOOL is not on the channel's allowlist."
