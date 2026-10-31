#!/usr/bin/env bash
# test/helpers/shard-verdict.sh <os> <shards-result> <records-dir>
#
# The body of test.yml's `test (<os>)` jobs: the one check branch protection reads for a
# platform, standing for that platform's N shards. Green only if
#
#   1. GitHub's own verdict on the shards is `success` — not failure, not cancelled, not
#      skipped. A required check that is SKIPPED counts as passing, which is why the job that
#      runs this is `if: always()` and this, not GitHub, decides;
#   2. every shard left a record, all of them for the same N; and
#   3. those records cover the plan: every group of the suite ran exactly once, in the shard
#      the plan gave it, and each shard reached the summary (shard-plan.mjs cover).
#
# Each shard's own conclusion is listed first, from the run's job list, so a red here names
# the shard to open instead of asking the reader to find it.
set -uo pipefail
os="$1"; result="$2"; dir="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rc=0
say() { printf '%s\n' "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; }

say "### test ($os)"
say ""
# 1a. Per shard, for the reader. Best effort: the verdict below does not depend on it.
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ] && command -v gh >/dev/null 2>&1; then
  jobs="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100" 2>/dev/null \
          | jq -r --arg p "shards ($os) / " '.jobs[] | select(.name | startswith($p)) | "\(.conclusion // .status)\t\(.name)"' 2>/dev/null | sort -t$'\t' -k2)"
  if [ -n "$jobs" ]; then
    while IFS=$'\t' read -r concl name; do
      say "- \`$name\`: **$concl**"
      [ "$concl" = success ] || printf '::error::%s: %s\n' "$name" "$concl"
    done <<< "$jobs"
  else
    say "- (the shard jobs could not be listed; the verdict below still stands)"
  fi
  say ""
fi

# 1b. The verdict that counts.
if [ "$result" != success ]; then
  printf '::error::the %s shards did not all pass: %s\n' "$os" "$result"
  say "The shards' result is **$result**."
  rc=1
fi

# 2. The records, and the N they were run for.
shopt -s nullglob
recs=("$dir"/groups-run-"$os"-*-of-*/groups-run.txt)
if [ "${#recs[@]}" -eq 0 ]; then
  printf '::error::no %s shard left a record of the groups it ran\n' "$os"
  say "No shard left a record of the groups it ran."
  exit 1
fi
ns="$(for r in "${recs[@]}"; do d="${r%/groups-run.txt}"; printf '%s\n' "${d##*-of-}"; done | sort -u)"
if [ "$(grep -c . <<< "$ns")" -ne 1 ]; then
  printf '::error::the %s records disagree about how many shards there are: %s\n' "$os" "$(paste -sd' ' - <<< "$ns")"
  exit 1
fi
N="$ns"
files=()
for i in $(seq 1 "$N"); do
  f="$dir/groups-run-$os-$i-of-$N/groups-run.txt"
  if [ -f "$f" ]; then
    files+=("$f")
    say "- shard $i/$N: $(awk -F'\t' '$2 != "#end"' "$f" | grep -c .) groups in $(tail -1 "$f" | cut -f1)s"
  else
    printf '::error::%s shard %s/%s left no record: it failed or was cancelled before the suite ran\n' "$os" "$i" "$N"
    say "- shard $i/$N: **no record**"
    files+=(/dev/null)
    rc=1
  fi
done
say ""

# 3. The plan, statically, and what actually ran against it.
if ! node "$ROOT/test/helpers/shard-plan.mjs" check "$N"; then rc=1; fi
if out="$(node "$ROOT/test/helpers/shard-plan.mjs" cover "$N" "${files[@]}" 2>&1)"; then
  say "$out"
else
  printf '::error::the %s shards did not run the whole suite\n' "$os"
  say '```'; say "$(head -40 <<< "$out")"; say '```'
  rc=1
fi
exit "$rc"
