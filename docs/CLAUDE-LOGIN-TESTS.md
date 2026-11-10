# Account sign-in verification

The work is based on `local/phone-login` at `8e0711c`. No login was completed, no
real session received `/login`, and nothing was pushed, merged or deployed.

## Measurement

See [the measured pane, listener and code shape](MCP-LOGIN.md#claude-code-account-sign-in-measured-before-implementation).
The login captures are real, normalized captures at 56, 80, 120 and 200 columns.
The expiry fixture is explicitly synthetic, derived from the existing accounts test.
No real expiry capture existed in the starting fixtures.

## Isolation and limits

The two-host rig reuses the MCP login rig with separate fake homes, passkeys, pairing
records, projects and tmux namespaces. Its terminal is a stub: it hashes the received
code plus Enter in memory and reports equality and counts. It deliberately echoes the
code into scrollback so history cleanup has something to remove.
It separately counts Ctrl-U cleanup. The sentinel scan checks every regular file both
hosts wrote, including stdout, stderr, audits and request logs; pane history is checked
after cleanup. No sentinel value is printed in an assertion, including a failing one.
The second profile is another fake home/config directory, never a live profile.

The first broad selected run included the existing mod validator group, which can
restore its caller's original HOME for `claude plugin validate/test`. That invocation
cannot be claimed to have preserved the requested config isolation. No owner config
file or Keychain entry was explicitly inspected, but that helper's possible reads
were not audited. The committed account regression runner now supplies an outer fake
HOME and config, removes account-token environment variables, and blocks `security`,
so the validator cannot escape back to the caller's account. The final focused checks
use that runner.

Both simulated hosts ran locally on macOS. A real Linux host, successful provider
exchange, real account chooser, real iOS passkey and provider response latency were
not exercised. The local listener's `/callback` path was identified in the installed
binary, not by completing an HTTP callback. The ten-minute record expiry is a fallback,
not a measured provider lifetime. A successful Finish result proves submission to the
prompt, not that the provider accepted the account or its organization policy.

## Red-first checks

The detector was tested against 119 fixture/width cases in each of `C` and
`en_US.UTF-8`. A deliberately blind detector failed nine positive cases; an always-on
detector failed 110 negative captures. These mutations used a disposable source copy.

`node test/helpers/account-login-red-check.mjs` edits only each rig's disposable runtime.
The mutations disable Start, Finish, history clearing, retained-input clearing, busy
refusal, expiry, prompt validation, local and home passkeys, pair signatures, nonce
replay protection, project scope, record consumption, pane privacy, notification rearm
and profile labeling. Additional mutants break profile disambiguation, erase the
accepted prompt, or skip draining existing readers. A deliberate code log must trip
the sentinel scan. The busy
typing mutant removes the independent prompt guards too, so the assertion proves no
`/login` was queued, not merely that a different guard stopped it.

`node test/helpers/account-login-card-red-check.mjs` separately breaks the large profile
label, dedicated Finish verb, draft secrecy, single-session Start target and fleet
socket. All five
mutants produced the expected red assertion, at both viewport sizes where applicable.

The initial busy-typing mutation hit an earlier identical condition instead of Start.
Its proof failed; replacing all matching guards fixed the mutation, and the targeted
rerun observed the expected red assertion. That failed proof was not counted as a pass.

## Commands and results

The initial explicit selection ran 165 filters, without invoking the full suite:
**8,312 passed, two failed, one skipped**. The failures were the new grid reason being
unconditionally present in the ordinary card schema, and Chrome failing to answer the
stack read-rate evaluation within 60 seconds. The schema now emits the reason only on
an account wall. The skipped check required an unavailable speech encoder/model.

The committed default selection lists 167 filters, adding the two remaining agent
detector groups. The 167-filter default was not rerun as a single invocation. The
initial 165-filter selection plus focused runs covered its groups.

The first focused rerun used 14 filters (15 groups) and passed **1,036 checks**, with
no failures or skips. It included the corrected schema, both additional detector
groups, the stack retry, the mod validator under the outer fake HOME, the accounts
groups, both login groups, syntax, web committed-build checks, and repository sweeps.
A subsequent focused run had **642 passes and one failure**: an ordinary concurrent
pane read was incorrectly treated as a private submission, fabricating an idle grid
row. Shared read leases and a separate submission gate fixed it. A new assertion also
went red because terminal reset erased the accepted prompt; Ctrl-U plus history
clearing now preserves that prompt.

The final source passed **811 checks in 12 groups, zero failures, zero skips**:

```sh
node test/helpers/account-login-regressions.mjs \
  'Claude account' 'MCP phone login' '--json: the §4 schema' \
  "the GRID's own verdict on a real pane" \
  'accounts: several logins per profile, failover at the limit' \
  'accounts planner: spend the allowance that expires first' \
  'phone client: web/ ships, parses, and is what its source builds' \
  'no real project name in the tree' \
  'no assertion pipes into a short-circuiting reader' \
  "a tmux read does not depend on the caller's locale" 'syntax'
```

Across the red-first runs, **22 distinct server mutations** produced their expected
failing assertions. The initial 18-case run observed 17 and failed the busy-typing
proof; after fixing the mutation, its targeted rerun passed. The profile-label,
profile-scope, blank-pane and reader-drain targeted runs supplied the other four.
These are actual red observations, not 22 claimed successes from the first command.
The final card mutation command observed all **five** expected failures. The two
detector mutations are separate: **29 deliberate broken variants** in total.

```sh
node test/helpers/account-login-red-check.mjs
node test/helpers/account-login-red-check.mjs busy-types
node test/helpers/account-login-red-check.mjs profile-label profile-scope
node test/helpers/account-login-red-check.mjs blank-pane reader-drain
node test/helpers/account-login-card-red-check.mjs
LC_ALL=C node test/helpers/account-login-detector-check.mjs
LC_ALL=en_US.UTF-8 node test/helpers/account-login-detector-check.mjs
node test/helpers/pwa-check.mjs
node test/helpers/tmux-read-sweep.mjs
npm run build
node test/helpers/login-card-check.mjs web <output-directory> account
```

The standalone PWA check passed **382 assertions**. The standalone final card render
passed **67 assertions**. The tmux read sweep exited zero with no findings, and the
production build succeeded. The selected web group also rebuilt out of tree and
compared committed output. The sentinel scan and both cleaned pane histories found
no code; introducing a code log and omitting history clearing were each seen failing.

After staging the verification docs and runner, the final name, short-circuiting
reader, tmux `-u` and syntax selection passed **267 checks**, with no failures or
skips, using the isolated runner and those four named filters.

## Card shots

Headless captures were retained under ignored `node_modules/.claude-login-scratch/shots/`:

- `390x844-pending.png`, `390x844-done.png`, `390x844-expired.png`
- `1440x900-pending.png`, `1440x900-done.png`, `1440x900-expired.png`

All six were opened and visually inspected. The directory also retains the Sign in
state at both sizes. Scratch configs, servers, data and logs are removed after checks;
PNGs are retained locally and are not committed.
