# Team terminal and editor: screen contract

The server is ready for a project-level Terminal and Editor. Both use the same
transport as the normal web client (`lib/web-term.mjs`). They share the desk's
fleet socket, folder and tmux tab: `_term-<project>` for a login shell,
`_edit-<project>` for Neovim or `CLAUDE_FLEET_EDITOR`. Opening attaches to an
existing tab when possible. Closing a browser connection preserves that tab.
The existing session pane reader remains read-only and is a separate feature.

## Open

`POST /api/term/open`, with the usual login cookie, `X-GFW: 1`, and JSON:

```json
{"project":"acme-web","kind":"term","cols":80,"rows":24}
```

`kind` is required: `term` or `edit`. Size is optional. Integer columns 2–500
and rows 1–300 are accepted; invalid or omitted initial values default to 80×24.
Success is HTTP 200:

```json
{"ok":true,"project":"acme-web","kind":"term","session":"_term-acme-web","ticket":"<opaque>","ttl":30,"idle":1800}
```

An admin or a member/admin of **this project** can open either kind. A viewer
or a person with no grant gets 404. No passkey, terminal-enable setting or
password re-entry is involved. Accounts with a temporary password must complete
the existing password-change flow first (403).

Project names must match the server's freshly read project list. Leading `-`,
`+ : . = { }`, spaces, slashes and other target syntax are refused before any
subprocess. Internal hyphens are retained for fixture names such as `acme-web`.
The client cannot choose a tmux session: only the exact tab for this project and
kind is accepted, and real mode checks it against a fresh UTF-8 tmux session list
before issuing a ticket and again before attaching.

## Connect and frames

Immediately open `GET /api/term/ws?ticket=<URL-encoded-ticket>` as a WebSocket
on the app's own host and port (use `ws:` for an HTTP app and `wss:` for HTTPS).
The browser supplies its cookie and Origin. Origin is **required** and must
exactly equal the listener's scheme plus the checked request Host, including its
port. Forwarded headers do not select an origin. A proxy must preserve Host and
the listener's scheme; TLS termination at an HTTP proxy is not supported by this
origin derivation. The normal direct HTTP listener works without configuration.

Tickets live for 30 seconds, are stored hashed, and authorize one upgrade only.
They belong to the user **and the login cookie** that requested them. Spending a
ticket with the wrong login also invalidates it. Role, account and tab existence
are rechecked at upgrade; access is checked every second while attached. Keep
tickets in memory only; never put them in logs, storage, analytics or navigation
URLs. Each reconnect needs a new POST and ticket.

Use the normal client's framing (RFC 6455 WebSocket messages):

| Direction | Message | Screen action |
|---|---|---|
| Server → screen, text JSON | `{"t":"hello","project":"acme-web","kind":"term","session":"_term-acme-web","idle":1800}` | Show the connection identity; wait for ready before enabling typing. |
| Server → screen, binary | Terminal bytes, including ANSI escapes and initial screen repaint | Feed bytes directly into the terminal emulator; use `binaryType = 'arraybuffer'`. UTF-8 characters can cross messages. |
| Server → screen, text JSON | `{"t":"ready","pane":"%0"}` | Enable typing; `pane` is optional (absent in demo). |
| Screen → server, binary | Raw UTF-8 input bytes | Send keyboard/paste bytes only after ready. Input before ready is discarded. |
| Screen → server, text JSON | `{"t":"resize","cols":100,"rows":40}` | Send measured emulator dimensions after fitting and whenever the panel changes size. Invalid sizes are ignored. |
| Server → screen, text JSON | `{"t":"closed","code":4001,"why":"Another connection took over this terminal."}` | Disable input and display `why`; follow the close actions below. |
| Either direction, WebSocket close | Standard close frame | Close when leaving the panel/project; release emulator and resize listeners. |

The browser handles ping/pong itself. JSON input is not keystroke input. Unknown
JSON and malformed JSON are ignored. Client messages are limited to 1 MiB;
fragmented messages are reassembled by the shared parser. Unmasked or otherwise
malformed frames close with a protocol error. Server output applies socket
backpressure to the tmux control client.

## Errors and screen behavior

HTTP errors on POST are JSON: `{"ok":false,"text":"..."}`. Upgrade refusals
are plain HTTP responses before 101. Browsers hide upgrade status/body from
JavaScript; a WebSocket error before hello must show a connection failure with
an explicit **Open again** action. Do not automatically loop on retries.

| Status | Meaning | Screen action |
|---|---|---|
| 200 / 101 | Ticket issued / socket attached | Follow hello → repaint → ready. |
| 400 | Invalid JSON, kind, or WebSocket handshake | Show the message; correct the request before trying again. |
| 401 | Missing/expired login or missing, used, expired, or another login's ticket | On POST, return to login. On socket failure, refresh `/api/health` to distinguish login expiry from an unusable ticket; offer a fresh open. |
| 403 | Temporary password, missing `X-GFW`, bad Host or wrong/missing Origin | Enter the password-change flow when `user.mustChange` is set; otherwise show the error and fix the request/origin. Do not request a passkey. |
| 404 | Project unavailable to this user, unsafe/unknown name, or tab removed before attach | Hide/disable the project action and refresh project access. Do not expose whether another user's project exists. A removed tab can be opened again after refresh. |
| 405 | Open requested with a method other than POST | Fix the client request. |
| 413 | Request body exceeds team's existing 256 KiB cap | Fix the request; terminal pastes belong on the WebSocket. |
| 502 | Shell/editor could not open, or attachment setup failed | Show the message and offer retry. For `no editor on this machine — the installer adds Neovim, or set CLAUDE_FLEET_EDITOR`, show the installation/configuration advice. |
| 500 | Unexpected server failure | Show failure and offer explicit retry; keep any unsent screen state locally in memory. |

After hello the server sends a `closed` notice before the close frame when
possible. Abrupt network loss may provide neither; treat browser code 1006 as a
connection loss and offer a fresh open.

| Close code | Meaning | Screen action |
|---|---|---|
| 1000 | Browser closed, or the shell/editor exited | Disable typing; offer Open again when appropriate. |
| 1001 | Server stopping, or browser stopped answering pings | Show disconnected; offer Open again after connectivity returns. |
| 1002 / 1009 | Invalid frames / message larger than 1 MiB | Show the reason; fix framing or split the paste before retry. |
| 1011 | tmux could not attach/repaint | Show the reason; offer Open again. |
| 4000 | 30 minutes without input **or output** | Show idle/disconnected and Open again. The desk tab remains alive. Resize and ping/pong do not count as activity. |
| 4001 | A second socket for this user/project/kind took over | Show the takeover reason; require an explicit Open again so two screens cannot reconnect forever. |
| 4003 | Login, password requirement or project grant changed | Refresh health/access; go to login/password change or remove the project action. |

There is one live socket per user/project/kind, across all that user's login
cookies. Other users, projects and the other kind have independent connections.

## Demo and activity

`--demo` uses these exact routes, tickets, Origin and authorization checks. It
starts no subprocess, tmux session, shell or editor. The terminal prints one demo
notice and echoes binary input. The editor prints a demo notice and a short
canned `acme-web/scratch.js` file, then echoes input. It is not a real editor;
show the notice without implying changes were saved. Resize is accepted without
starting a process.

Each successful WebSocket attachment writes one `terminal_open` activity row;
every close writes exactly one `terminal_close` row. Rows contain user, project,
kind, subject (tab), duration in seconds (0 at open), result, timestamp, and a
bounded close reason. Unused tickets are not attachments. Input/output bytes,
commands, pasted text and tickets never enter these rows. The screen must not
add its own terminal content to the activity log.

Server coverage: `test/terminal.test.mjs` exercises the HTTP server in demo mode
with every child_process entry point blocked; `test/terminal-real.test.mjs`
uses an isolated `$TMUX_TMPDIR`, the real fleet-tab and the shared control bridge.
