# web/ — the phone client

The fleet grid, as a Progressive Web App. Design: [`docs/mobile.md`](../docs/mobile.md)
— §4 is the JSON, §6 is the client and layout, §7 is parity and the confirmations.

It is **not a second design**. `bin/fleet-grid.mjs` computes its column count from the
window width (`const nc = cols()`), so a phone is `nc = 1`, and the card is the same
five lines `cardLines()` draws — the same box-drawing characters, the same 32 columns,
the same nine statuses with the same glyphs and colours. `web/grid.js` is a
transcription of those functions, and `test/helpers/grid-parity.mjs` **lifts the real
ones out of `fleet-grid.mjs` and diffs their output against it, card for card**. That is
the only thing keeping the two in step, because this kind of drift is silent: a card
that still renders is a card that still looks right.

```
╭─ 1 coi-beside ───────────────╮
│ ◆ working            busy 41s│   status left · age right (or ↻ reset, or @scheduled)
│ coi-beside · feat/coi-polic… │   worktree · branch  (+ agent when it isn't claude)
│ "All three states present. R…│   last message, quoted
╰──────────────────────────────╯
```

| the grid, `nc = 1` | all nine statuses | projects |
|---|---|---|
| ![grid](../docs/mobile/grid.png) | ![statuses](../docs/mobile/statuses.png) | ![projects](../docs/mobile/projects.png) |

| a session | the TUI's own confirmation, and its force step |
|---|---|
| ![session](../docs/mobile/session.png) | ![confirm](../docs/mobile/confirm.png) |

## Running it

Zero dependencies, no build step, no `npm install` — plain HTML, CSS and ES modules that
any static server can serve:

```bash
cd web && python3 -m http.server 8000     # or any static server
open http://localhost:8000
```

`localhost` matters if you want the passkey: WebAuthn needs a secure context, and
`http://` on a LAN or tailnet IP is not one. The app says so rather than failing
mysteriously, and in fixture mode it offers a clearly-labelled way past — there is no
server there to protect.

With no server configured it runs entirely from `fixtures/`. Point it at `fleet-serve`
in **settings → connection** (or `localStorage.setItem('gf.base', 'http://…')`) and
nothing else changes.

## Files

| | |
|---|---|
| `index.html` | the shell — small on purpose, it is what a cold offline open paints |
| `grid.js` | the cards, as strings. Mirrors `cardLines`/`newCardLines`/`freeCardLines`/`boxCard`/the counts header. No DOM, no fetch |
| `app.js` | the three screens, the four gestures, the verbs and the confirmations |
| `api.js` | **the only file that talks to the network**, and the fixture backend |
| `passkey.js` | the WebAuthn ceremonies (§5, §7) |
| `sw.js` | offline: cache-first for the app, network-first with fallback for `/api/*` |
| `fixtures/` | §4 payloads, and the projects/checkouts/settings/session reads |
| `icons/make-icons.mjs` | rasterises the grid's own `SHIP` sprite into the home-screen icons |

## Screens and gestures

Projects → grid → session, mirroring the desktop. §7's key-to-touch mapping:

| terminal | phone |
|---|---|
| `1-9` / `⏎` | tap a card |
| `⇧hjkl` reorder | drag a card **by its title line** (the grip — the rest of the card still scrolls) |
| `p` / `P` | swipe ← pause · swipe → resume |
| `x` | long-press |
| `,` settings · `Ctrl-p`/`Q` projects · `q` back | buttons in the footer bar, key letter included |

The keyboard bindings are wired too — the same letters — so a desktop browser or a
Bluetooth keyboard behaves like the TUI.

**Two things are deliberately absent** (§7), and a substitute for either is the mistake:

- **the stack** — it exists to put four sessions side by side, and a phone has no side.
  At `nc = 1` that is this card list.
- **`Ctrl-t` terminal / `Ctrl-n` editor tabs** — they open a shell and neovim in the
  session's folder. There is no local shell on a phone, and streaming a remote one is a
  bigger surface than the whole rest of the design.

The settings sheet says both out loud, so the gap reads as a decision rather than as
something half-built.

## Destructive verbs

`spawn` and `stop --reclaim` are in scope — a read-only phase was considered and
rejected (§7): an app that reports a worker has been blocked since 9pm and cannot answer
it has not solved the problem, it has described it more conveniently.

What stands in front of them is identity and confirmation, not reduced capability:

- **the TUI's own prompts, reproduced verbatim** — `kill session 'x'?`,
  `remove worktree 'api-3' (feat/x)?`, `y = yes · any other key = cancel`, and
  `f = remove anyway` as its **own** key. `pwa-check.mjs` reads those strings out of
  `fleet-grid.mjs` and asserts the phone carries the same ones.
- **a passkey at the moment of action** for `spawn`, `stop`, `rename` and removing a
  worktree, plus one at every open and after the app has been backgrounded.
  `stop --reclaim` takes **both** confirmations, because it is the one verb that can
  delete work (§12).
- **an audit row for every mutating call**, visible in settings.

None of that is the enforcement. §5: *server-enforced, not client-enforced* — the
assertion's job is to make the server mint a short-lived token, and the server refuses
anything without a live one. The lists in `api.js` decide which taps ask for a
fingerprint; `curl` never runs them.

## What `fleet-serve` has to answer

```
GET  /api/projects                          -> { home, projects: [ … ] }
GET  /api/grid?project=<name>               -> docs/mobile.md §4, verbatim
GET  /api/session?project=&session=&limit=20[&before=<ts>]
                                            -> { session, total, messages: [{ts,role,text}], next_before, note? }
GET  /api/checkouts?project=<name>          -> { roots, checkouts }
GET  /api/settings?project=<name>           -> { global_nudge, sessions: { name: on|off|inherit } }
POST /api/verb   { tool, args }             -> { ok, text }         Bearer token required
GET  /api/auth/challenge                    -> { challenge, rp_id, user }
POST /api/auth/register | /api/auth/assert  -> { token, expires_at }
```

`tool` is the **MCP tool name, unchanged** — `fleet_list`, `fleet_send`, `fleet_read`,
`fleet_spawn`, `fleet_worktrees`, `fleet_inbox`, `fleet_answer`, `fleet_pause`,
`fleet_resume`, `fleet_stop`, `fleet_rename`, `fleet_project_add`, `fleet_projects` — so
the daemon dispatches through the handlers it already has (§2) rather than growing a
second vocabulary.

Eight more are things the **grid** does by writing a marker file or calling a sibling
script, and have no MCP tool today. They are the only additions this client asks for:

| verb | what the TUI does today |
|---|---|
| `fleet_schedule` | `s` — writes `<sock>.<session>.sched` and spawns `bin/fleet-schedule` |
| `fleet_label` | `l` — the display label on a card |
| `fleet_nudge` | per-session / per-project `notify-lead` markers |
| `fleet_budget` | per-project "ignore the usage ceiling" marker |
| `fleet_order` | `⇧hjkl` — `<sock>.order` plus the `@cf_order` tmux option |
| `fleet_project_order` | `⇧hjkl` on the Projects screen |
| `fleet_project_remove` | `x` on the Projects screen — the list entry only |
| `fleet_worktree_remove` | `x` on a **FREE** card, and the `force` that follows a refusal |

Two notes for whoever wires the server up:

- **Serve `.js` as `text/javascript` and `.webmanifest` as `application/manifest+json`.**
  A module served as `text/plain` is blocked outright, and the failure looks like a blank
  page.
- **`web/package.json` is `{"type":"module"}` for node's benefit, not the browser's** —
  it is what lets `node --check` and the test helpers read these `.js` files as ES
  modules. Don't remove it.

## Pagination

20 messages, with an explicit "load more" (§11.3). That bound is about **not pulling
46 MB down a tunnel on cellular** — it is a performance decision, not a security
control, and content is served **unredacted**. Anything that describes it as a redaction
has misread the design.

## Offline

The service worker precaches the app and the fixtures (cache-first) and keeps the last
successful `/api/*` response (network-first, falling back to it). `app.js` also mirrors
the last payload into `localStorage`, so a cold open with no network paints the fleet as
it was and labels it `⚠ offline — last fetched 9:04p` instead of showing a blank page. A
stale grid with a timestamp beats an error page; a stale grid presented as live would be
the lie.

## Tests

```bash
./test/run.sh                          # the suite, including the two helpers below
node test/helpers/grid-parity.mjs      # phone card == TUI card, line for line
node test/helpers/pwa-check.mjs        # self-containment, precache, icons, §4 fixtures, §7 prompts
```

Both emit `name <US> want <US> got` rows that `test/run.sh` feeds to its own `is`. Every
assertion in them was watched going red before it was trusted — a two-column glyph, a
folded `unknown`, a swapped counts clause, a reworded confirmation, a fixture left out
of the precache, a CDN link in the HTML.
