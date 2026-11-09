# lib/review-gate.sh — the REVIEW GATE: no PR merges until an independent review passed at
# its head commit. Sourced, not run, by hooks/fleet-guard.sh (the refusal), bin/claude-here
# (the contract clause), hooks/fleet-event.sh (READY vs DONE) and bin/fleet-review (the
# record).
#
# WHY A SETTING THAT IS BOTH SAID AND ENFORCED. The loop this encodes — open the PR, have a
# second model review it, fix, review again, merge only when clean — was run by hand on
# another fleet and worked better than trusting the author. Written only into a brief it is
# the shape claude-here already documents above its CONTRACT: a rule a session reads once
# and then talks itself past. So the clause is in the system prompt of every gated session
# AND the merge is refused in front of the tool, for every session, the lead included.
#
# THE ON/OFF SWITCH is a boundary marker (lib/boundary.sh: project, session, session-off,
# most specific wins), and its polarity is the reverse of the other two: they LIFT a line
# when on, this one DRAWS one. So the rule about who may write it is reversed with it — a
# lead may turn it on, and no session may turn it off (fleet-guard.sh); a human does that
# from a terminal or the grid's settings page.
#
# THE OTHER FOUR are values, project-wide, read here with a default each:
#   <sock>.review-model    the reviewer subagent's model       sonnet
#   <sock>.review-level    the code-review skill's level       medium
#   <sock>.review-stalled  stalled rounds before STUCK         3
#   <sock>.review-rounds   rounds in all before STUCK          8
#
# THE RECORD, one file per PR under <fleet-dir>/<sock>.reviews/<owner>~<repo>~<n>.tsv, one
# row per round, tab-separated and never an empty column ("-" stands in), so it is read
# with awk -F'\t' and a tab's IFS-whitespace collapse cannot shift it (CLAUDE.md):
#   epoch  session  round  head-sha  findings  fingerprints  stalled  verdict  model  level  note
# verdict is continue | pass | stuck. A SERIES is the rows after the last pass or stuck: a
# push after a pass starts a new one, so the caps count one attempt at one head, not the
# whole life of a PR that went back for more work.

REVIEW_GATE_KEYS="model level stalled rounds"

review_gate_default() {
  case "$1" in model) printf sonnet ;; level) printf medium ;; stalled) printf 3 ;; rounds) printf 8 ;; esac
}

# review_gate_valid <key> <value> -> 0 when the value is one the key takes.
# The model is the Agent tool's own `model` choice, not any model id: the reviewer is a
# subagent, and that parameter takes only these names — a full id would be refused by the
# tool at the moment the worker reaches for it, long after the setting was written.
# The level is the code-review skill's, minus `ultra`: that one is a billed cloud review a
# person launches, and a setting must not be a way for an agent to launch it.
review_gate_valid() {
  case "$1" in
    model)   case "$2" in sonnet|opus|haiku|fable) return 0 ;; esac ;;
    level)   case "$2" in low|medium|high|xhigh|max) return 0 ;; esac ;;
    stalled|rounds) case "$2" in ''|*[!0-9]*) return 1 ;; esac; [ "$2" -ge 1 ] && [ "$2" -le 99 ] && return 0 ;;
  esac
  return 1
}

# review_gate_value <fleet-dir> <sock> <key> -> the value in force. A file that holds
# something invalid falls back to the default with a word on stderr: a typo must never
# reach the clause, where it would become an instruction a worker cannot carry out.
review_gate_value() {
  local f="$1/$2.review-$3" v=""
  [ -f "$f" ] && v="$(head -1 "$f" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$v" ] && review_gate_valid "$3" "$v"; then printf '%s' "$v"; return 0; fi
  [ -n "$v" ] && echo "review-gate: ignoring review-$3 '$v' in $f (not a valid value)" >&2
  review_gate_default "$3"
}

# review_gate_on <fleet-dir> <sock> [<session>] -> 0 when the gate is on there.
review_gate_on() {
  command -v boundary_on >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/boundary.sh"
  boundary_on review-gate "$1" "$2" "${3:-}"
}

# 0 when the gate is on ANYWHERE in this fleet — the project or any one session. The guard
# asks this first, with no network, so that with the setting off a merge costs one glob and
# nothing else changes: no `gh` call, no new refusal, no new wording.
review_gate_anywhere() {
  local f
  [ -f "$1/$2.review-gate" ] && return 0
  for f in "$1/$2".*.review-gate; do [ -f "$f" ] && return 0; done
  return 1
}

# review_key <pr-url> -> owner~repo~number, or nothing for a URL that is not a PR's.
review_key() {
  local u="${1%/}" n o r
  case "$u" in */pull/[0-9]*) ;; *) return 1 ;; esac
  n="${u##*/pull/}"; u="${u%/pull/*}"; r="${u##*/}"; u="${u%/*}"; o="${u##*/}"
  case "$o$r$n" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$n" in *[!0-9]*) return 1 ;; esac
  printf '%s~%s~%s' "$o" "$r" "$n"
}

review_file() { printf '%s/%s.reviews/%s.tsv' "$1" "$2" "$3"; }

# review_passed_at <record-file> <sha> -> 0 when the LAST row recorded at that sha is a pass.
# The last, not any: a later round at the same head that found something (a re-review asked
# for after the pass) withdraws it.
review_passed_at() {
  [ -f "$1" ] && [ -n "$2" ] || return 1
  awk -F'\t' -v s="$2" '$4 == s { v = $8 } END { exit !(v == "pass") }' "$1" 2>/dev/null
}

# review_last_pass <record-file> -> the sha of the newest pass, for a refusal to name.
review_last_pass() {
  [ -f "$1" ] || return 0
  awk -F'\t' '$8 == "pass" { s = $4 } END { if (s != "") print s }' "$1" 2>/dev/null
}

# review_local_state <fleet-dir> <sock> <session> <local-head> -> "<state>\t<pr>\t<sha>"
# for the Stop hook, which must not go to the network on every turn. The newest record this
# session wrote decides: a pass at the commit checked out here is READY (the pass was taken
# at the PR's head, so a local HEAD equal to it is a pushed one); a stuck is STUCK; anything
# else — nothing recorded, a pass at an older commit, rounds still open — is PENDING.
review_local_state() {
  local dir="$1" sock="$2" sess="$3" head="$4" best="" bt=0 f t
  for f in "$dir/$sock.reviews"/*.tsv; do
    [ -f "$f" ] || continue
    t="$(awk -F'\t' -v s="$sess" '$2 == s { t = $1 } END { print t + 0 }' "$f" 2>/dev/null)"
    [ "${t:-0}" -gt "$bt" ] && { bt="$t"; best="$f"; }
  done
  if [ -z "$best" ]; then printf 'pending\t-\t-\n'; return 0; fi
  local pr="${best##*~}"; pr="${pr%.tsv}"
  awk -F'\t' -v s="$sess" -v h="$head" -v pr="$pr" '
    $2 == s { v = $8; sh = $4; if ($4 == h) hv = $8 }
    END {
      if (hv == "pass") printf "ready\t%s\t%s\n", pr, h
      else if (v == "stuck") printf "stuck\t%s\t%s\n", pr, sh
      else printf "pending\t%s\t%s\n", pr, sh
    }' "$best"
}

# ── findings ─────────────────────────────────────────────────────────────────
# The reviewer is told to answer in lines `FINDING <file>:<line> <summary>` or the single
# line `NO FINDINGS`. An answer with neither is NOT a clean review — it is a review that did
# not happen, or output from something else — and is refused rather than read as zero: a
# wrapper that turned "could not parse" into "nothing found" would be the one lie this gate
# exists to prevent (bin/fleet-review says the same of a reviewer that exits non-zero).
review_findings() { grep -E '^[[:space:]]*FINDING[[:space:]]+[^[:space:]]' | sed -E 's/^[[:space:]]*FINDING[[:space:]]+//'; }
review_says_clean() { grep -Eqx '[[:space:]]*NO FINDINGS[[:space:]]*'; }

# One fingerprint per finding: the file without its line number, plus the summary folded to
# lowercase words with the digits taken out, first twelve words. Line numbers move when code
# above a finding changes, and a reviewer rewords; this is the part that holds still more
# often. It will still miss a finding reworded from scratch — which is why the total-rounds
# cap exists beside the stalled one.
review_fingerprints() {
  local line file rest norm
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    file="${line%%[[:space:]]*}"; rest="${line#"$file"}"
    file="$(printf '%s' "$file" | sed -E 's/:[0-9][0-9,:-]*$//')"
    norm="$(printf '%s' "$rest" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z\n' ' ' | tr -s ' ' | sed 's/^ //' \
            | awk '{ n = (NF < 12 ? NF : 12); o = ""; for (i = 1; i <= n; i++) o = o (i > 1 ? " " : "") $i; print o }')"
    printf '%s|%s' "$file" "$norm" | cksum | awk '{ print $1 }'
  done | sort -u | paste -sd, -
}

# review_round_verdict <record-file> <head> <findings> <fingerprints> <cap-stalled> <cap-rounds>
#   -> "<round>\t<stalled 0|1>\t<stalled-total>\t<verdict>\t<why>\t<repeats>"
# The whole of the cap arithmetic, in one place the suite can drive with no network.
#   A round is STALLED when it changed nothing (the same head as the round before it in the
# series) or its findings repeat the round before's (every fingerprint was already there).
# A clean round is never stalled: no findings at an unchanged head is simply a pass.
review_round_verdict() {
  local f="$1" head="$2" n="$3" fps="${4:--}" cs="$5" cr="$6"
  [ -f "$f" ] || f=/dev/null
  awk -F'\t' -v head="$head" -v n="$n" -v fps="$fps" -v cs="$cs" -v cr="$cr" '
    { if ($8 == "pass" || $8 == "stuck") { k = 0; st = 0; ph = ""; pf = "" ; next }
      k++; st += ($7 + 0); ph = $4; pf = $6 }
    END {
      r = k + 1; stall = 0; rep = 0
      if (n + 0 > 0 && k > 0) {
        if (head == ph) stall = 1
        if (fps != "-" && pf != "-" && pf != "") {
          split(pf, a, ","); for (i in a) seen[a[i]] = 1
          m = split(fps, b, ","); all = 1
          for (i = 1; i <= m; i++) { if (b[i] in seen) rep++; else all = 0 }
          if (all && m > 0) stall = 1
        }
      }
      tot = st + stall
      if (n + 0 == 0)       { v = "pass";  why = "no findings" }
      else if (tot >= cs + 0) { v = "stuck"; why = tot " stalled rounds (cap " cs ")" }
      else if (r >= cr + 0)   { v = "stuck"; why = r " rounds (cap " cr ")" }
      else                    { v = "continue"; why = "-" }
      printf "%d\t%d\t%d\t%s\t%s\t%d\n", r, stall, tot, v, why, rep
    }' "$f"
}

# The inbox a session's events land in: its sub-lead's when it has one, else the fleet's.
review_inbox() {   # <fleet-dir> <sock> <session>
  local p=""
  [ -f "$1/$2.$3.parent" ] && p="$(head -1 "$1/$2.$3.parent" 2>/dev/null)"
  if [ -n "$p" ]; then printf '%s/%s.%s.inbox' "$1" "$2" "$p"; else printf '%s/%s.inbox' "$1" "$2"; fi
}
