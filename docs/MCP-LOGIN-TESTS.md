# Local phone login verification

The two-host fixture runs entirely on one Mac. Both hosts have isolated homes,
configurations, projects, audit files and scratch ports. No real authentication,
provider page, live fleet or deployment was used. Every suite run had its own tmux
namespace. The full suite was not run.

## Commands and results

- `./test/run.sh "MCP phone login"`: **163 passed**, no failures or skips.
- The selection reproduced by `node test/helpers/phone-login-regressions.mjs` uses
  88 filters and reports 90 groups, including two nested audit groups. Its initial
  run had **6,943 passes, one failure and one skip**. The failure caught countdown
  startup before the last declaration. Startup was moved into the boot section;
  the failed check and affected client helpers were rerun successfully below.
- `claude plugin validate mods/ghostfleet`: passed.
- `node test/helpers/login-card-check.mjs web .scratch/phone-login/screenshots`:
  **65 checks**, no mismatches; ten PNGs retained and visually inspected.

Each client helper was run as `node test/helpers/<file>`:

| File | Checks | Mismatches |
| --- | ---: | ---: |
| `grid-parity.mjs` | 428 | 0 |
| `pwa-check.mjs` | 382 | 0 |
| `pane-check.mjs` | 74 | 0 |
| `doc-fixtures.mjs` | 42 | 0 |
| `waiting-check.mjs` | 16 | 0 |
| `speak-check.mjs` | 182 | 0 |
| `speech-check.mjs` | 40 | 0 |
| `md-check.mjs` | 98 | 0 |

Those are **1,262 checks**, with no failed helpers. The committed build/source check
passed in the broad run; the final cache pin and startup check passed in `pwa-check`.

This final filtered suite reported **384 passed**, no failures or skips:

```bash
./test/run.sh \
  "free_port answers in digits" \
  "fleet-serve: a message of photos never deletes itself" \
  "push:" \
  "no real project name in the tree" \
  "no assertion pipes into a short-circuiting reader" \
  "a tmux read does not depend on the caller's locale" \
  "no tracked file carries this machine's home path" \
  "nothing a checkout makes for itself is tracked" \
  "every dir a bin imports from is one cf-sync copies" \
  "the npm package ships only files the sweep reads" \
  "the npm package's bin survives npm's publish-time fixes" \
  "no withheld name in what npm actually ships" \
  "the pre-push hook refuses to publish a withheld name" \
  "syntax"
```

## Failure evidence and limits

Thirty-eight deliberately broken copies produced failing assertions: 28 server/hook
variants and ten client variants. They covered capture, permissions, expiry, scope,
fan-out, every replay target check, reuse, home assertions, signatures, nonce replay,
both audit paths, code leaks on each host, cleanup, redirect following, HTTP status,
notifications, provider display, card states, the countdown, field clearing, typing,
the Finish route and the client audit. The passing two-host run scans every file both
hosts wrote, including stdout/stderr, for a randomized sentinel code. The provider
stub also echoes that code in its response and redirect header; neither is retained.

The skipped broad check was speech encoding through whisper.cpp: the required tools
or model were absent. Actual Linux execution, iOS passkey behavior, provider OAuth
completion, real push/Telegram delivery, and a live hook firing were not exercised.
The real listener lifetime could not be measured; the implemented fallback is ten minutes.

Screenshots are under `.scratch/phone-login/screenshots/`, named
`390x844-<state>.png` and `1440x900-<state>.png`, for `pending`, `first-time-site`,
`expired`, `done` and `claude.ai`. Scratch servers, state and logs are removed after checks.
