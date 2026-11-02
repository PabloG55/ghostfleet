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
| L3. Messages from the owner sent by phone or Telegram arrived as lead briefs under the proof rule: 82 proof prompts | fixed | #109 | Phone covered (`fleet-send --owner` from the phone server only). The Telegram relay lives outside this repo; the change was handed to that bot's owner |
| L4. "Waiting on you" items never expired: 27 of 35 had 3+ later messages from the person, and 34 were over 24h old | fixed | #109 | — |
| L5. The note named tools no session had: ~15,800 injections at ~740 chars | fixed | #109 | — |
| L6. Items carried from paused or moved workers piled up in a lead: 23 open | fixed | #109, #117 | #117 bounds the `gh` lookup with a timeout. Clearing the 23 items already carried into one lead needs the owner's OK (`fleet-ledger drop-carried`) |
| L7. 22 open items in dead sessions never stopped | fixed | #117 | — |
| L8. 80 exact duplicates within one session | fixed | #117 | — (identical sends within 10 minutes fold into one) |
| L9. 16 ledgers duplicated across two profiles after a resume that crossed profiles | fixed | #117 | No new copies. The 16 existing duplicate pairs stay until the owner OKs a cleanup |
| L10. What the judge costs could not be counted | fixed | #117 | — (`fleet-meter --ledger`) |
| L11. 53 account-resume notices recorded as requests | fixed | #92 | — (fixed before this audit) |
| L12. 120 extra turns: 82 proof prompts, 38 gate re-prompts | improved | #108, #109 | — |

## Work-fleet flow and token audit

13 days on one busy work fleet: 146 sessions, 68,392 calls, ~2.8B input-equivalent tokens.
401 of its 418 PRs merged, with a median of 2h.

| Finding | Status | PR | Still owed |
|---|---|---|---|
| S1. 83% of spend was cache reads; the average context was 420k, and 54% of spend came at ≥500k context | fixed | #111 | Running sessions take the 300k ceiling only at their next start. Restarting them needs the owner's OK |
| S2. 64% of the lead's turns were finish-nudges, 57% of those only looked, a median of 2.7 min apart | fixed | #112 | — (now one gather per quiet window) |
| S3. 25% of spend went to task-notification wakes; 2,785 polling commands | improved | #115, #111 | #115: the session contract and orchestrate skill now say one background CI watch, then end the turn. Why not fixed: polling is the model's choice, and a guard that forbade it would also block legitimate waits |
| S4. Every worker ran on the top model, including verify, CI, docs and video work | fixed | #115 | Model by task kind, opt-in per project. Turning it on for a project changes that fleet's models, so it needs the owner's OK |
| S5. 4.5% of spend was cache rewrites after idle resumes | improved | #111 | Why not fixed: idle compaction was measured and does not fire, so the only lever is a smaller context to rewrite |
| S6. Subagents took 6% of spend | open | — | Open by design: no waste found in subagent use |
| S7. 4 prompts stranded in the send queue | fixed | #110 | Re-sending or discarding the 4 stranded prompts needs the owner's OK |
| S8. 14 lead wakes expired because the input box held text | fixed | #112 | — (the held wake now shows on the band and the phone) |
| S9. 2 of 4 messages relayed to the work lead through Telegram got no reply | in progress | — | Outside this repo: handed to the Telegram bot's owner (each relay asks for a reply) |
| S10. Leads re-brief finished sessions that carry huge contexts | improved | #115, #111 | #115 adds the skill rule |
| S11. Scratch sessions inherit a worker's environment and report as that worker (9 false DONEs seen during this audit) | fixed | #114 | — |
| S12. Stray text in the lead's input box can block its wakes | improved | #112 | #112 shows the held wake. Why not fixed: only the owner may clear the input box |
| S13. The worker guard refused a `fleet-ack` because its prose named a merge or a setting: 2 refusals live (found during this work) | fixed | #116 | — |

## Measuring the result

Re-run `fleet-meter --context` and `fleet-meter --ledger` over the two weeks after 2026-11-02 and compare against the baselines in this file.
