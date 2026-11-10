# web/ui — the shared screens

The fleet's screens, written once: the board of what every session is doing, a project's
sessions and its tree, one session's chat and terminal, the live map, the frame they sit in,
the desk's keys, the words and the brand's pieces. Preact, MIT.

Two apps are built on it. The team app (`ee/team/`, under the Team License) wraps these
screens with its people: sign-in, roles, owners, the company AI account, usage caps and
admin. The phone client (`web/app.js`) takes the keyboard rules today and, in phase 2, the
screens too, over fleet-serve's API. Neither the screens nor anything else in this folder
may import from `ee/`: core never depends on the licensed half, and the licensed half
imports core by relative path.

**Why here and not a package of its own:** it sits beside `web/md.js` and `web/ansi.js`,
which are the same kind of thing (UI code the client ships), it ships in the npm package
through `files: web/` with no new entry, and both builds already reach it (the team app's
vite, and the root vite that builds `web/screens.js`).

| File | What it is |
| --- | --- |
| `adapter.jsx` | `FleetProvider`, `useFleet()`, `useSlot()`: how a screen reaches the fleet |
| `shell.jsx` | `Frame` and `Sidebar`: the sidebar (a drawer on a phone), the tab title, the routes |
| `home.jsx` | the first page: the board, and the Projects screen's keys |
| `board.jsx` | the board by state (needs you, working, ready, quiet) |
| `project.jsx` | a project's sessions, its tree of worktrees, the new-session dialog |
| `session.jsx` | one session: chat, the agent's screen (read only), composer, its actions |
| `terminal.jsx`, `terminal.css` | a project's Terminal and Editor tabs, over the phone client's `../term.js` |
| `map.jsx` | the live map |
| `fleet.jsx`, `sprite.js`, `lights.js`, `icon.jsx` | the ships, the status lights, the icon set |
| `ui.jsx` | buttons, pills, `Modal`, `Confirm`, toasts, `usePoll`, `Markdown` |
| `history.js` | one history for every way back, framework-free: `go`, `back`, each entry's scroll and state |
| `back.jsx` | `BackLink` (names where it goes), `useKept` (a screen's state, kept per history entry) |
| `keys.js` | the keyboard's rules, framework-free (the phone client imports these) |
| `keyboard.jsx` | the keyboard for the Preact screens: one listener, each screen's keys |
| `i18n.js`, `words/` | the words in English and Spanish, and `t()` |
| `ui.css`, `skin.css` | the shared rules, and the shared skin over them |

## The adapter

A shared screen never calls an `/api` of its own. An app wraps them once:

```jsx
<FleetProvider adapter={myAdapter}>…</FleetProvider>
```

and every screen reads `useFleet()`. The team app's adapter is `ee/team/web/src/adapter.js`.
Phase 2 writes the phone client's, over fleet-serve. An adapter is a plain object:

| Member | Shape | What the screens use it for |
| --- | --- | --- |
| `grid(project)` | → `{ cards, free_worktrees }` | a project's sessions (the cards, in the fleet's order) and its unused worktrees; also how Ctrl-f's "card N" finds card N |
| `session(project, name, before?)` | → `{ messages, status, owner?, queued?, next_before? }` | a session's chat; passing `next_before` back as `before` reads the older page |
| `pane(project, name)` | → `{ pane, prompt?, here? }` | the terminal's text; `prompt` is an open question, with its `fingerprint`; `here` is who else has the session open, for the `presence` slot |
| `act(tool, args, opts?)` | → `{ text, queued? }` | every change (below); `queued` is `'question'` or truthy when it waits behind a turn |
| `attach(project, session, file)` | → `{ path }` | an upload; the composer cites the path |
| `attachPerMessage` | number | how many files one message may carry |
| `lead(project)` | → `{ started }` | start the project's lead session if it is not running; `started` says which it was |
| `presence(project, session, typing)` | optional | say who is looking; a single-user app leaves it out |
| `canTerm(project)` | optional | whether this person may type into the project; the Terminal and Editor tabs show only when it says so and `termOpen` and `termSocket` are there too |
| `termOpen(project, kind, size)` | optional, → `{ ticket, session }` | a ticket for the project's shell (`'term'`) or editor (`'edit'`); a refusal throws an `Error` carrying its HTTP `status` |
| `termSocket(ticket)` | optional, → `WebSocket` | the socket for one ticket, with `binaryType` `'arraybuffer'` |
| `termAccount()` | optional, → `{ mustChange }` or `null` | who is signed in now, to tell a temporary password from another refusal |
| `signIn()`, `changePassword()` | optional | the app's own sign-in and password screens, offered by a closed tab's notice |
| `go(to, { replace? })` | | navigate to a hash route (`'/p/acme-web'`); pass `history.js`'s `go`, which never pushes the screen you are on and keeps `from` on a replace |
| `place(route)` | optional | what an app's own route is called on a back link (`'/activity'` → "Activity"); the shared routes are named already |
| `slots` | object | the app's own pieces (below) |

A failed call throws an `Error` whose `message` is shown to the person as it is. If the
answer is that the session changed under the person (an answer to a question that has
already gone), the error carries `body.changed` and the screen reloads instead.

### act(): the vocabulary

The tool names are the fleet's own (the `fleet_*` MCP tools), plus three of the team
server's (`gfw_*`). `opts.confirm` says the person already confirmed it in a dialog.
`opts.owner` is the new session's owner, and is left undefined to mean "the person asking".

| Tool | `args` (beside `project`, and `session` for a session's) | `opts` |
| --- | --- | --- |
| `fleet_send` | `{ prompt }` | |
| `fleet_answer` | `{ text, no_enter, expect }` (`expect`: the question's fingerprint) | |
| `fleet_interrupt`, `fleet_wake`, `fleet_reopen`, `fleet_pause`, `fleet_resume` | none | |
| `fleet_stop` | `{ reclaim? }` | `confirm` |
| `fleet_rename` | `{ new_name }` | `confirm` |
| `fleet_spawn` | `{ name, prompt?, model?, branch?, from?, force_new? \| reuse? }` | `owner` |
| `fleet_worktree_remove` | `{ path }` | `confirm` |
| `gfw_schedule` | `{ at, msg? }` (`at` in epoch seconds) | |
| `gfw_unschedule` | none | |
| `gfw_label` | `{ text }` | |

**For phase 2:** fleet-serve does not serve a schedule or a label yet. `fleet_schedule` and
`fleet_label` are in its `NOT_YET` list, because the grid owns those marker files. So an
adapter over fleet-serve must either answer the two `gfw_*` tools with a clear error, which
the screen shows as a toast, or wait for fleet-serve to grow them. It must not map them to a
path the grid does not read.

### Slots

A slot puts something of the app's own into a shared screen without the screen knowing what
it is. Each one is a plain function that returns markup or `null`. It is not a component,
so it must not call hooks. All of them are optional, and a screen with no slot draws nothing
there, which is exactly what a single-user app is.

| Slot | Called as | Where |
| --- | --- | --- |
| `ownerName` | `(session) → string \| null` | the board and the map: whose session it is, in words |
| `ownerBadge` | `(session, size) → markup` | the board and the map: their avatar |
| `cardFoot` | `(card) → markup` | the foot of a session's card |
| `treeOwner` | `(card) → markup` | a row of the project tree |
| `filterCards` | `(cards, filter) → cards` | which cards a filter keeps (default: all) |
| `filterChips` | `({ cards, filter, setFilter }) → markup` | the filter chips above the cards |
| `spawnOwner` | `({ value, onChange }) → markup` | the owner field in the new-session dialog |
| `ownerPicker` | `({ project, name, owner, onChanged }) → markup` | the session header's owner |
| `presence` | `(here) → markup` | who else has this session open (`here` is the pane's list) |
| `author` | `(message) → markup` | who sent a message in the chat |

## The frame and the routes

`Frame` is the page around every screen. What belongs to the app comes in through props
(`shell.jsx` lists them): the wordmark, the tab title, extra nav links, a banner, what
floats over the page, and `settings`, the route `,` opens. The frame also mounts the keyboard.

The shared routes are `#/` (home), `#/map`, `#/p/<project>` and
`#/p/<project>/s/<session>`, and `sharedRoute(hash)` parses them. Either of the last two
followed by `/term` or `/edit` is the project's Terminal or Editor tab. An app adds its own beside
them: the team app has `#/automations`, `#/activity`, `#/settings` and `#/admin/…`.

## Back and the history

Back goes to the screen the person came from, as it was. A session opened from the live map
goes back to the map, scrolled where it was and with "Show projects with no sessions" still
ticked. It used to go to a fixed parent, the session's project page, while the browser's back
went to the map: two backs, two answers. Now there is one history, the browser's, and every way
back walks it: the back link, the browser's button, a phone's back swipe, and the keys
(`` ` `` and Ctrl-a g/d on a session, q and `` ` `` on an automation).

- **What an entry knows.** `history.js` stamps each entry in `history.state.gfEntry` with
  `{ id, from }`, where `from` is the route before it. The phone client keeps its own depth in
  `history.state.gf`, a different key, so neither reads the other's.
- **`back(parent)`** steps back one entry when there is one to step back to, which is exactly
  what the browser's back does. Opened by a link in a new tab or a pasted address, there is
  none, and back *replaces* the entry with `parent`, the screen's logical parent: a session's
  is its project's sessions. Replaced, not pushed, so the browser's back from there leaves the
  app instead of landing on the session again. A reload keeps `from`, because
  `history.state` survives one.
- **`go(to)`** pushes an entry, and does nothing when `to` is the screen already showing, so
  back never takes two presses. `{ replace: true }` is for a screen that is gone or was only a
  step on the way (a renamed session; the project page Ctrl-f passes through to reach a card),
  and it keeps the entry's `from`.
- **As it was.** Each entry keeps the scroll of `.main` and of every element marked
  `data-keep-scroll="<name>"` (the chat, the map's ticker), in memory and in sessionStorage
  for a reload. A screen keeps its own state with `useKept(key, initial)` in place of
  `useState`: the map's boxes, a project's filter chip, the board's quiet list, the team app's
  Activity filter. A new entry starts at the top with `initial`; an entry gone back to gets
  what it had. A screen that stays mounted from one entry to the next takes the new entry's
  value when it changes. The sidebar's search term keeps itself, because the sidebar never
  unmounts.
- **The link says where.** `<BackLink parent=… />` reads "← Live map", "← acme-web" or
  "← api-fix", from `placeName(route)`, with the app's `place(route)` for its own routes
  ("← Automations"). Its aria-label is "Back to …". It is a real link, so a middle click opens
  the destination in a new tab, and a plain click is `back()`. On a phone it carries a
  thumb-sized box round its small words, without moving anything.

## CSS and words

Load order matters, because each layer can override the one before it:

1. `brand/tokens.css`
2. `web/ui/ui.css`, the shared rules
3. the app's own rules
4. `web/ui/skin.css`, the shared skin
5. the app's own skin

An app that offers the Terminal and Editor tabs also loads `web/xterm.css` and then
`web/ui/terminal.css`, after its own skin.

Colours come only from the tokens.

Every word on a shared screen goes through `t()` from `i18n.js`, and lives in
`words/en.js` and `words/es.js` with the same keys. An app's own words live in the app's
own catalog and are merged in with `addWords`. A key lives in exactly one catalog. Which
language is spoken is the app's decision (`setLangSource`), not this folder's.

## The keyboard

The keys are the desk's, the same ones the tmux fleet answers, so a hand that knows one
knows the other. Five rules hold everywhere (`keys.js` spells out why):

- **A text box owns the keyboard.** `q` typed into a search is a letter. The one exception
  is a session's composer, which lets through exactly the keys tmux takes while you type to
  the agent: `` ` ``, ⇧←/⇧→, Ctrl-s, Ctrl-p, Ctrl-f and Ctrl-a.
- **⌘ is the system's.** No key with ⌘ held is ever taken.
- **An IME is never interrupted.** A key that arrives mid-composition belongs to the IME.
- **The on-screen keyboard keeps its return key.** On a phone ⏎ starts a new line. With a
  real keyboard, a mouse or a trackpad, ⏎ sends and ⇧⏎ starts the new line.
- **A dialog owns the keyboard while it is open**, and Esc closes it.

Digits count in the fleet's own order (the desk's), not the board's order of urgency.

| Where | Key | Does |
| --- | --- | --- |
| everywhere | Ctrl-f | the jump chord: `<p> <s>` card s of project p · `<p> ⏎`/`m` its lead · `<p> s` or `s <p>` its sessions · `p` home · Esc, Ctrl-f, Ctrl-c cancel |
| everywhere but home | Ctrl-p, Q | home |
| home | 1–9 | the lead of project N |
| home | ←→↑↓ / hjkl | move between projects; ⏎ opens the one in focus |
| home | Ctrl-s | the focused project's sessions |
| home | / | find a project; ⏎ opens the first match, Esc clears |
| home, a project's sessions | , | settings |
| a project's sessions | ←→↑↓ / hjkl | move between cards; ⏎ opens the one in focus |
| a project's sessions | 1–9 | open card N |
| a project's sessions | n, N | new session |
| a project's sessions | q, `` ` ``, Ctrl-c | the project's lead |
| a session | `` ` `` | back to the screen it was opened from, as it was; opened by a link, its project's sessions (the lead's too) |
| a session | ⇧← / ⇧→ | the previous / next session, the lead first, wrapping |
| a session | Ctrl-s | its project's sessions |
| a session | Ctrl-a then g, d, s, p, f, ←, → | the desk's prefix table: back, back, sessions, home, jump, previous, next |
| an automation, the automations list | q, `` ` `` | back: the list it was opened from, as it was; home from the list (team app) |
| a session | any letter, ⏎ | goes to the composer, as every unbound key goes to the agent at the desk |
| the composer | ⏎, ⇧⏎, Esc | send (with a keyboard), new line, leave the box |
| a question | y | yes, unless it asks you to type a name |

What the desk has and these screens do not, and why:

| Desk key | Why not here |
| --- | --- |
| H/J/K/L (reorder) | there is no order to change here, and fleet-serve does not serve a reorder yet (`fleet_order` and `fleet_project_order` are in its `NOT_YET` list) |
| s, p/P, x on a card | scheduling, pausing and stopping are the session page's buttons; a card carries no verbs |
| t, Ctrl-x, Ctrl-a x (the stack) | there is no stack on these screens yet |
| w (new worktree) | worktrees are made by a new session, not on their own |
| Ctrl-a t, Ctrl-a n (terminal, editor) | the terminal here is read-only; the terminal and editor come in a later phase |
| / on a project's sessions; search n/N/⌫ | there is no search over sessions |
| the queue and reviews keys | there is no queue or reviews screen |
| ⏎ on Projects = its master | ⏎ is the focused link's own (it opens the project); the digit is the master |
| any other key cancels a question | Tab has to walk the dialog |
| c, Ctrl-c Ctrl-c, Ctrl-a Ctrl-a, Ctrl-t/n/w | no meaning here, or the browser's own |

A screen adds its keys with `useKeys((key, event, layer) => took)`. The screen mounted last
is asked first. What no screen takes falls to the keys every screen shares.

## Not here yet

The **assistant** and **automations** are still in `ee/team/web/src/`:

- The assistant talks through the team's company AI account and installs voices on the team
  server.
- Automations read and write the team server's store in five places, and only an admin may
  edit them.
- The phone client already has an automations screen of its own (`web/src/automations.jsx`),
  over fleet-serve.

Moving either means growing the adapter by those calls, and that is phase 2's to define
against fleet-serve, where the two automations screens become one.
