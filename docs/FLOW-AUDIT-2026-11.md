# Flow audit, November 2026: the checklist

The running list of what the November 2026 audit found, one row per finding. A PR that
fixes three findings appears in three rows, so this list can say exactly what is still owed
for each one. Where a fix is still on a branch, the PR column names the branch until it has
a number.

When a row changes, edit it here in the same PR that changes it.

Status is one of **fixed**, **in progress**, **improved** (better, though the finding still
stands in part) or **open**.

## Ledger audit

14 days across all fleets on one machine: 497 sessions, 3,898 ledger items.

| Finding | Status | PR | Still owed |
|---|---|---|---|
| L1. Plain instructions were ledgered: 75% of typed requests (1,204 of 1,607) closed before the person's next message, yet each one showed on the band and in the note | fixed | #108 | — |
| L2. Agents closed items through `fleet-ledger` from Bash 3,305 times and through the MCP tools 0 times. A CLI close carried no turn, so the "agent closed everything, skip the judge" path never fired | fixed | #108 | — |
| L3. Messages from the owner sent by phone or Telegram arrived as lead briefs under the proof rule: 82 proof prompts | in progress | #109 | #109 covers the phone. The Telegram bot change lives outside this repo and is owed after #109 |
| L4. "Waiting on you" items never expired: 27 of 35 had 3+ later messages from the person, and 34 were over 24h old | in progress | #109 | Lands with #109: 24h expiry, re-judged on the person's turn |
| L5. The note named tools no session had: ~15,800 injections at ~740 chars | in progress | #109 | Lands with #109 (a shorter note) |
| L6. Items carried from paused or moved workers piled up in a lead: 23 open | in progress | #109 | #109 auto-closes on merge and drops carried items. Clearing the 23 that exist now needs the owner's OK |
| L7. 22 open items in dead sessions never stopped | in progress | `fix/ledger-hygiene` | The branch |
| L8. 80 exact duplicates within one session | in progress | `fix/ledger-hygiene` | The branch |
| L9. 16 ledgers duplicated across two profiles after a resume that crossed profiles | in progress | `fix/ledger-hygiene` | The branch |
| L10. What the judge costs could not be counted | in progress | `fix/ledger-hygiene` | The branch |
| L11. 53 account-resume notices recorded as requests | fixed | #92 | — (fixed before this audit) |
| L12. 120 extra turns: 82 proof prompts, 38 gate re-prompts | improved | #108, #109 | #109 to merge |

## Work-fleet flow and token audit

13 days on one busy work fleet: 146 sessions, 68,392 calls, ~2.8B input-equivalent tokens.
401 of its 418 PRs merged, with a median of 2h.

| Finding | Status | PR | Still owed |
|---|---|---|---|
| S1. 83% of spend was cache reads; the average context was 420k, and 54% of spend came at ≥500k context | fixed | #111 | Sessions already running take the 300k ceiling only at their next start. Restarting them needs the owner's OK |
| S2. 64% of the lead's turns were finish-nudges, 57% of those only looked, a median of 2.7 min apart | fixed | #112 | — (now one gather per quiet window) |
| S3. 25% of spend went to task-notification wakes; 2,785 polling commands | improved | `feat/model-by-kind`, #111 | Skill guidance on the branch; #111 makes each turn cheaper. Polling is the model's choice, not something ghostfleet can forbid |
| S4. Every worker ran on the top model, including verify, CI, docs and video work | in progress | `feat/model-by-kind` | The branch (opt-in per project) |
| S5. 4.5% of spend was cache rewrites after idle resumes | improved | #111 | None possible: #111 makes the contexts smaller to rewrite. Idle compaction was measured and does not fire, so no lever is left |
| S6. Subagents took 6% of spend | open | — | Nothing: no waste found. Open by design and noted only |
| S7. 4 prompts stranded in the send queue | fixed | #110 | Re-sending or discarding the 4 needs the owner's OK |
| S8. 14 lead wakes expired because the input box held text | fixed | #112 | — (the held wake now shows on the band and the phone) |
| S9. 2 of 4 messages relayed to the work lead through Telegram got no reply | in progress | — | The Telegram bot change, outside this repo |
| S10. Leads re-brief finished sessions that carry huge contexts | improved | `feat/model-by-kind`, #111 | A skill rule on the branch |
| S11. Scratch sessions inherit a worker's environment and report as that worker (9 false DONEs seen during this audit) | in progress | `fix/foreign-done` | The branch |
| S12. Stray text in the lead's input box can block its wakes | improved | #112 | #112 shows it. Only the owner may clear the box |
