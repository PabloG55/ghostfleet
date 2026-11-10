# MCP authorization from the phone

An MCP `authenticate` result with a localhost redirect creates a private, ten-minute
pending login. The Projects and queue screens show it, including logins on paired
machines. Open the provider, authorize, then copy the full failed localhost redirect
from the phone browser into the card. Finish asks for a fresh passkey on the host
serving the phone app. That host forwards a signed request to the session's host,
which validates its own pending record and replays one GET to its own loopback listener.

The callback never goes through a session prompt, MCP tool, transcript, ledger, client
history, knowledge event or notification. Audits record the outcome without the query.
A refused target or state does not consume the login; a network attempt does, including
a timeout or an HTTP error. Restart authentication in the session after expiry or a
failed attempt. A successful callback HTTP status means the listener accepted the
request; it does not independently prove that the provider granted every requested scope.

claude.ai connectors have no loopback callback. Their cards link to
[connector settings](https://claude.ai/settings/connectors); they cannot accept a paste.
An unfamiliar provider has a first-site warning. Check the displayed host before opening.

## Deployment

Both machines need the updated `bin/fleet-serve.mjs` and `lib/logins.mjs` in their staged
runtime, followed by a restart of each fleet-serve service. Copy the updated `web/` to
the Linux host serving the phone app (and to the other host if its own app is used).
The phone must fully close and relaunch its installed app to load cache version v101.

The session host also needs the updated `mods/ghostfleet/hooks/` directory, including
`hooks.json`, `login-shape.js` and `login-capture.mjs`. New Claude Code sessions must load
that plugin configuration; a session that already loaded the old hooks has no capture
hook. Apply the same hook update on the Linux host for sessions running there. Existing
pairing, project sharing, push subscriptions and Telegram configuration are reused.
No new port or public OAuth callback is needed. Nothing is deployed by the tests.

## Verification

`./test/run.sh "MCP phone login"` runs two isolated fleet-serves, a synthetic passkey,
a fake push service and an in-memory callback listener, plus headless card checks.
`node test/helpers/phone-login-regressions.mjs` runs 88 explicit filters (90 reported groups)
of changed-file readers, their fixtures, and the required repository sweeps.
`node test/helpers/login-card-check.mjs web <output-directory>` retains screenshots
at 390×844 and 1440×900 for pending, first-site, expired, done and connector states.
The real listener lifetime was not measured: no real authentication was started, so
the capture uses the ten-minute fallback.

See [the local verification record](MCP-LOGIN-TESTS.md) for commands, counts and limits.
