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
The phone must fully close and relaunch its installed app to load cache version v103.

The session host also needs the updated `mods/ghostfleet/hooks/` directory, including
`hooks.json`, `login-shape.js` and `login-capture.mjs`. New Claude Code sessions must load
that plugin configuration; a session that already loaded the old hooks has no capture
hook. Apply the same hook update on the Linux host for sessions running there. Existing
pairing, project sharing, push subscriptions and Telegram configuration are reused.
No new port or public OAuth callback is needed. Nothing is deployed by the tests.

### codex sessions

A codex session runs the same `login-capture.mjs`, from codex's own `PostToolUse` hook:
`hooks/codex-fleet-event.sh` hands it the payload unchanged. install.sh registers that hook in
`$CODEX_HOME/hooks.json` with the matcher above and trusts it in `config.toml`, and the
capture finds the session through the record the codex bridge writes under codex's thread id.
As with every codex event, it does nothing in a work profile's fleet or outside a fleet. Its
deployment is the codex bridge's: `cf-sync`, then `./install.sh` for the hook and its trust
record, then a new codex session.

What it covers is narrower than for Claude Code. Claude Code itself gives an MCP server that
needs OAuth a `mcp__<server>__authenticate` tool. codex 0.166.0 has no such tool: its binary
says to run `codex mcp login <server>`, a command with a loopback callback of its own, and
that sign-in never passes through a tool result, so nothing here can capture it. The codex
capture fires only for an MCP server that implements an `authenticate` tool itself and
returns the URL in its result. That path was proven with the recorded codex `PostToolUse`
payload and a stub codex (`./test/run.sh "codex: an MCP authenticate result"`), not with a real
codex call: the shape of a real MCP `tool_response` from codex was not measured, so both a
string and content blocks are tested.

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

## Claude Code account sign-in: measured before implementation

Measured Claude Code **2.1.321** with `HOME` unchanged, a fresh `CLAUDE_CONFIG_DIR`
under ignored scratch, and a private `TMUX_TMPDIR`. Browser opening and the `security`
command were blocked through scratch PATH shims. No account was signed in, no real
credential was submitted, and no Keychain command was run. The fake config directory
and its tmux server were removed after measurement.

After the theme and account-method choices the actual pane said:

```text
Browser didn't open? Use the url below to sign in (c to copy)
https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=<challenge>&code_challenge_method=S256&state=<state>
Paste code here if prompted >
```

The URL wraps at 56, 80, 120 and 200 columns. Those are captured fixtures, with
per-attempt challenge/state values replaced while preserving the captured wrapping.
`lsof -nP -a -p <scratch-pane-pid> -iTCP -sTCP:LISTEN` showed
`127.0.0.1:62758 (LISTEN)`: an ephemeral port on this attempt. `lsof` cannot show an
HTTP path; inspection of the installed binary identifies `/callback`. The pane's
manual URL instead uses the hosted `/oauth/code/callback`. The phone uses that manual
flow and pastes a code, rather than replaying a loopback GET as the MCP card does.

Without authenticating, the installed paste handler establishes only the shape:
two nonempty URL-safe parts separated by `#`, **authorization-code#state**. No real
code, its length, or a successful exchange was measured. An unsubmitted dummy paste
was mostly replaced by asterisks, but a suffix remained visible in the pane and its
captured history. Ctrl-U removed the input from the widget. This changes the cleanup
premise: after sending the code and one Enter, Finish also sends Ctrl-U, then clears
history before app pane readers may resume. It preserves the resulting CLI prompt;
resetting the terminal would leave the phone looking at a blank pane. The
code submission and cleanup control are asserted separately. Finish never captures
or prints the pane after typing the code.

Searching all of `test/` and `web/fixtures/` for `/login` found no real captured
mid-life expiry screen. The existing accounts group synthesizes
`API Error: 401 · OAuth token revoked · Please run /login`; the new explicitly named
`claude-account-expired-synthetic.txt` preserves that provenance. Its width cases are
tested, but are **not evidence of a captured real expiry**. Obtaining one by expiring
an owner's session would violate this task's isolation rule. Existing real idle and
busy captures are negative cases for the new detector in both locales.

## Account card and paired completion

An account wall reports `need-you` with `login_reason: Claude account sign-in`.
The same login-card family shows the session, host and large profile label. Sign in
targets one nonbusy session; a busy turn is refused without queueing `/login`.
The card carries its fleet socket, so identically named projects in two profiles
cannot send Sign in to the first profile in the projects list. An ambiguous request
without a fleet socket is refused.
An already-open paste prompt retains its existing attempt. Otherwise Start sends
`/login`, chooses the displayed Claude subscription method, and records the resulting
URL, session, socket, pane identity, issuing server and profile label in a private
ten-minute record. No config path, token or pasted code is stored in it.

Open visits the provider; Finish asks for a fresh passkey on the app's home host.
`fleet_account_login_finish` crosses as a signed pair request, and the session host
validates its own unused, unexpired record and current prompt before consuming it.
The pending URL is removed on consumption. A private gate blocks new grid and pane
captures, and Finish waits for existing read leases to drain before typing. Ordinary
readers can coexist, so a simultaneous poll cannot fabricate an idle status.
An uncertain delivery keeps
the pane private, rather than silently reopening it. A pane being piped, in copy mode,
replaced, or running on a different tmux server is refused.

The code bypasses the generic verb history, ledger, knowledge events and transcript
paths. Request logs contain only the route. Audits contain outcome and authority,
never the paste or URL. Telegram names the session and profile and says to open the
app; push carries only the existing bounded needs-you metadata. The residual pair
risk remains explicit beside `PAIR_VERBS`: a compromised paired host could sign a
session into an account it controls, within the prompt-injection power `fleet_send`
already grants it.

The result means **code submitted**, not independent confirmation that the account
was accepted. A provider may still require an organization or policy choice. A real
successful login, browser account chooser, provider latency, and real iOS passkey
interaction were deliberately not exercised.

## Account deployment additions

On **both session hosts**, stage the updated `bin/fleet-serve.mjs`,
`bin/fleet-grid.mjs`, `lib/logins.mjs`, `lib/account-logins.mjs`,
`lib/account-login-shape.mjs`, and `lib/accounts.mjs`; restart each fleet-serve service
and reopen any running grid/Projects screen. `bin/fleet-agent` is an existing
dependency and is unchanged.
Stage `web/api.js`, `web/app.js`, `web/app.css`, and `web/sw.js` on the **Linux home
host** serving the phone, and on the Mac only if its own app is used. Fully close and
relaunch the installed phone app for cache **v103**. The earlier MCP hook deployment
requirements above still apply; this addition needs no new hook or account login at
deployment, no new command installation and no new port. Nothing was deployed.

See [the account verification record](CLAUDE-LOGIN-TESTS.md) for red-first checks,
selected regression commands, screenshot names and limits.
