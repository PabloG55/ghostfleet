#!/usr/bin/env bash
# test/helpers/mutation-audit.sh — does a green run mean anything?
#
#     test/helpers/mutation-audit.sh                 every group
#     test/helpers/mutation-audit.sh fleet-agent     the groups whose name matches
#     test/helpers/mutation-audit.sh --mode empty    a harsher break (see below)
#
# A suite answers "did anything break". It cannot answer "would I have noticed", and
# those come apart more often than they should: this repo has now found five groups
# that passed while measuring the wrong screen, and each was invisible for months
# because nothing ever asked them the second question.
#
# So: for each group, BREAK THE THING IT CLAIMS TO TEST and see whether it goes red.
# A group that survives a deliberate break of its own subject is not proving what its
# name says. This is mutation testing in spirit, and it is only affordable because
# run.sh's filter skips execution — a group costs about a second, so the whole sweep is
# minutes rather than the forty hours it would have been at fifteen minutes a group.
#
# THREE VERDICTS, NOT TWO, and the third is the one nobody expects:
#
#   red        the group noticed. This is the answer you want.
#   SURVIVED   its assertions ran and passed anyway.
#   VANISHED   its assertions did not run at all — every row skipped, or none emitted.
#
# VANISHED is the interesting one. A group that skips when its subject is broken exits
# 0, and a skip is not a failure, so the suite goes green having tested nothing. Found
# live: break bin/fleet-agent and `pane detectors (busy_re)` reports 0 passed / 0 failed
# / 3 skipped and says "no detector declared" — blaming a missing declaration for a
# broken binary. Counting only red-vs-green would have called that group healthy.
#
# THE BREAK HAS TO BE TO THE SUBJECT, NEVER TO THE TEST. Deleting an assertion reddens
# a group and proves nothing about it. These modes all edit product code:
#
#   noop    (default) insert an early exit, so the subject runs and does nothing.
#   empty   truncate the subject to nothing.
#   syntax  append `(((`, for a group whose claim IS that the file parses.
#
# USE BOTH noop AND empty BEFORE BELIEVING A SURVIVOR. Measured on the first full sweep:
# 28 groups survived `noop` and 25 of them went red under `empty`, because they lift an
# implementation out of the shipped file with awk and run it standalone — an inserted
# early exit never touches the text they read, so `noop` was not a break for them at
# all. A survivor of `noop` alone is a lead, not a finding.
#
# RESTORING IS THE PART THAT CAN HURT YOU. This edits tracked files in place, so every
# path restores — success, failure, timeout, ^C — and the tree is checked clean before
# and after each iteration. It aborts rather than continue against a repo it has
# corrupted, because a sweep that leaves a mutation behind looks exactly like a bug in
# whatever someone edits next.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

MODE=noop
case "${1:-}" in --mode) MODE="${2:?--mode needs a value}"; shift 2 ;; esac
ONLY="${1:-}"
PATHS="bin lib hooks mcp web skill tmux layouts install.sh test"
MUT=""

restore() { [ -n "$MUT" ] && git checkout -- "$MUT" 2>/dev/null; MUT=""; }
trap 'restore; exit 130' INT TERM
trap 'restore' EXIT
# TRACKED modifications only. An untracked file is not something `git checkout --` can
# clobber, and this script is itself untracked the first time anyone runs it — refusing
# to start because of that would be the tool failing on its own arrival.
clean() { [ -z "$(git status --porcelain -- $PATHS 2>/dev/null | grep -v '^??')" ]; }
clean || { echo "the tree is dirty before we start; commit or stash first" >&2; exit 1; }

# ── which file is a group ABOUT ──────────────────────────────────────────────
# The one it names most. A group reaches its subject as "$ROOT/bin/thing", so counting
# those is enough for 145 of the 171 groups. The rest reach it through a variable set by
# another group — $SV is a daemon started elsewhere — and are named here rather than
# guessed, because a wrong subject produces a green that means nothing at all.
subject_of() {                     # $1 = group name; echoes a path or ""
  case "$1" in
    fleet-serve*|"phone client: served by the daemon"*|free_port*) echo bin/fleet-serve.mjs ;;
    fleet-awake*) echo bin/fleet-awake ;;
    *) echo "" ;;
  esac
}
MAP="$(awk '
  function flush(  k, best, bn) {
    if (cur == "") return
    best = ""; bn = 0
    for (k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = k }
    printf "%s\t%s\t%s\n", cur, best, need
  }
  /^printf / && index($0, "passed") && index($0, "failed") { epi = 1 }
  epi { next }
  /^group "/ { flush(); cur = $0; sub(/^group "/, "", cur); sub(/".*$/, "", cur); split("", cnt); need = ""; next }
  /^# needs: / { if (cur != "") { need = $0; sub(/^# needs: /, "", need) } next }
  {
    if (cur == "") next
    s = $0
    while (match(s, /\$\{?ROOT\}?\/[A-Za-z0-9_.\/-]+/)) {
      p = substr(s, RSTART, RLENGTH); p = substr(p, index(p, "/") + 1)
      cnt[p]++
      s = substr(s, RSTART + RLENGTH)
    }
  }
  END { flush() }
' test/run.sh)"

RED=0; SURV=0; VANI=0; SKIP=0
printf '%-9s %-28s %-11s %s\n' VERDICT SUBJECT COUNTS GROUP
while IFS=$'\t' read -r grp file need; do
  [ -n "$grp" ] || continue
  case "$grp" in *"$ONLY"*) ;; *) continue ;; esac
  [ -n "$file" ] && [ -f "$file" ] || file="$(subject_of "$grp")"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    # NAMES NO PRODUCT FILE. For a harness self-test (`socket namespace`, `the harness
    # captures plain bytes`) that is exactly right and there is nothing to break. For
    # anything else it is the finding itself: a group that never mentions the product is
    # testing a copy of it. `session naming` reimplements the naming loop inside the test
    # and asserts on its own function, so no mutation anywhere can redden it.
    SKIP=$((SKIP+1)); printf '%-9s %-28s %-11s %s\n' 'no-product' '-' '-' "$grp"; continue
  fi

  MUT="$file"
  case "$MODE" in
    empty)  : > "$file" ;;
    syntax) printf '(((\n' >> "$file" ;;
    noop)
      case "$file" in *.mjs|*.js) ins='process.exit(0);' ;; *) ins='exit 0' ;; esac
      if head -1 "$file" | grep -q '^#!'; then
        { head -1 "$file"; printf '%s\n' "$ins"; tail -n +2 "$file"; } > "$file.mut" && mv "$file.mut" "$file"
      else
        { printf '%s\n' "$ins"; cat "$file"; } > "$file.mut" && mv "$file.mut" "$file"
      fi ;;
    *) echo "unknown --mode $MODE" >&2; exit 2 ;;
  esac

  # Its prerequisite too, or the filter refuses before anything runs. Killed by the pid
  # we captured, never by a pattern: a pattern that matches this run's node also matches
  # somebody's live daemon.
  if [ -n "$need" ]; then ./test/run.sh "$grp" "$need" > "$ROOT/.mutation-run" 2>&1 &
  else                    ./test/run.sh "$grp"         > "$ROOT/.mutation-run" 2>&1 & fi
  rpid=$!; i=0
  while kill -0 "$rpid" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done
  if kill -0 "$rpid" 2>/dev/null; then
    kill "$rpid" 2>/dev/null; sleep 1; kill -9 "$rpid" 2>/dev/null; verdict=timeout; counts='-'
  else
    wait "$rpid"
    sum="$(sed 's/\x1b\[[0-9;]*m//g' "$ROOT/.mutation-run" | grep -E '^[0-9]+ passed' | tail -1)"
    p_="$(printf '%s' "$sum" | sed -n 's/^\([0-9]*\) passed.*/\1/p')"
    f_="$(printf '%s' "$sum" | sed -n 's/.* \([0-9]*\) failed.*/\1/p')"
    k_="$(printf '%s' "$sum" | sed -n 's/.* \([0-9]*\) skipped.*/\1/p')"
    counts="${p_:-?}p/${f_:-?}f/${k_:-?}s"
    # A filter that REFUSED is not a red row — the suite never ran. Told apart by the
    # refusal text, because the exit code is non-zero either way.
    if grep -qE 'refusing to run|cannot be lifted out|no group matches' "$ROOT/.mutation-run"; then verdict=not-run
    elif [ "${f_:-0}" -gt 0 ]; then verdict=red; RED=$((RED+1))
    elif [ "${p_:-0}" -eq 0 ]; then verdict=VANISHED; VANI=$((VANI+1))
    else verdict=SURVIVED; SURV=$((SURV+1)); fi
  fi
  restore
  rm -f "$ROOT/.mutation-run"
  clean || { echo "the tree is dirty after $grp ($file); stopping before this spreads" >&2; exit 1; }
  printf '%-9s %-28s %-11s %s\n' "$verdict" "$file" "$counts" "$grp"
done <<< "$MAP"

printf '\n%s noticed the break  %s SURVIVED  %s VANISHED  %s named no product file\n' \
  "$RED" "$SURV" "$VANI" "$SKIP"
printf 'a SURVIVED under --mode noop is a lead, not a finding: re-run it with --mode empty.\n'
[ "$SURV" -eq 0 ] && [ "$VANI" -eq 0 ]
