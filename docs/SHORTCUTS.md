# ghostfleet — shortcuts & behavior notes

Living reference of every keybinding and non-obvious behavior in ghostfleet, kept up
to date as new ones are found or added. Each entry is tagged with where it came from:

- **[README]** — already documented there
- **[CODE]** — missing (or incomplete) in the README; found by reading
  `bin/fleet-grid.mjs` / `tmux/cf.tmux.conf` / `bin/ghostfleet` directly
- **[CONFIRMED]** — verified live, not just read in the source
- **[UPSTREAM]** — landed via an upstream commit after this doc was started

Two separate key-handling systems, and it matters which one you're in:
- **tmux** (`tmux/cf.tmux.conf`) handles keys *while attached inside a Claude
  session* (a live pane).
- **The Node TUI** (`bin/fleet-grid.mjs`) handles keys *on the Projects screen /
  the grid / the pickers* — no tmux involved there, it reads stdin directly.

---

## 1. Inside a session (tmux attached) — `tmux/cf.tmux.conf`

| key | what it does | source |
|---|---|---|
| `` ` `` (backtick, no prefix) | detach — one level back | README |
| `Ctrl-a g` | detach (mnemonic **g**rid) | README |
| `Ctrl-a d` | detach (plain) | README |
| `Ctrl-a` `Ctrl-a` | sends a literal `Ctrl-a` to Claude | README |
| `Ctrl-s` (no prefix) | drops a `.goto=grid` marker and detaches → the grid | README |
| `Ctrl-a s` | same as `Ctrl-s`, prefixed (fallback) | README |
| `Ctrl-p` (no prefix) | drops a `.goto=projects` marker and detaches → **straight to Projects**, from any session (master or worker) | [CODE] not in the README |
| `Ctrl-a p` | same as `Ctrl-p`, prefixed | [CODE] |
| `S-Right` / `S-Left` (no prefix) | **step to the next/previous session** in this fleet's ring (master first, then workers, wraps both ends) — a pure `switch-client`, the control plane is never involved, so it's instant with no redraw | [UPSTREAM] `bin/fleet-cycle` |
| `Ctrl-a Right` / `Ctrl-a Left` | same as `S-Right`/`S-Left`, prefixed (fallback) | [UPSTREAM] |
| `Ctrl-f` (no prefix) or `Ctrl-a f` | opens the **jump table** (`cfjump`) — see below | README (summarized), [CODE] (full detail) |

### The jump table (`Ctrl-f …`) — every step

Pressing `Ctrl-f` puts tmux into a temporary key-table (`cfjump`) that shows a hint at
the bottom and waits for the next key — **none of this reaches Claude**, `Esc` cancels
at any step:

1. **`Ctrl-f`** → *"jump → project? 1-9 · s + digit = grid · p = projects · esc"*
2. Then:
   - **digit 1-9** → enters that project's sub-table (`cfjump<N>`), asking for the next step:
     - **digit 1-9** → `jumps:<project>:<session>` — that exact session in that project
     - **Enter** or **`m`** → `jumpm:<project>` — that project's **master**
     - **`s`** → `jump:<project>` — that project's **grid**
     - **Esc** → cancels
   - **`p`** → goes straight to **Projects**
   - **`s`** → asks for one more digit → `jump:<project>` (that project's grid — short form, skips the per-project sub-menu)
   - **`Escape`** → cancels

So: `C-f 1 1` = project 1, session 1. `C-f 1 ⏎` (or `C-f 1 m`) = project 1's master.
`C-f 1 s` = project 1's grid. `C-f s 1` = the same, short form. `C-f p` = Projects.
[CODE] — the README only summarizes this in one comment line in `bin/ghostfleet`,
without detailing the sub-steps or that `Escape` cancels at any level.

### `fleet-awake` — keeping the machine alive for the whole session

Not a keybinding, but worth knowing: `bin/ghostfleet` arms `fleet-awake` (an idle-sleep
inhibitor) for as long as the control plane is up, so a background worker never
freezes mid-turn because the machine slept. `CLAUDE_FLEET_AWAKE=display` also pins the
screen on (useful when a dark screen would otherwise look indistinguishable from a
slept machine); `=off` disables it; `fleet-awake --status` reports what's currently
holding an assertion. [UPSTREAM]

---

## 2. **Projects** screen (Node TUI, `onKeyProjects`)

| key | what it does | source |
|---|---|---|
| `↑↓` / `k j` | move selection | README |
| `←→` / `h l` | move selection (column) | README |
| `⇧h` `⇧j` `⇧k` `⇧l` (`H J K L`) | **reorders** the selected project in the list (persisted to the file) | README |
| `⏎` | enters that project's **Master Claude** | README |
| `Ctrl-s` | **straight to that project's grid**, skipping master | README |
| `s` / `S` | schedule a message to that project's master | README |
| `,` | opens the **settings** screen (see below — it has 2 columns, not 1) | README (incomplete) |
| `x` | asks for confirmation (`y`/`Y`) to remove the project from the list | README |
| **digit `1`-`9`** | **insta-jump**: opens the project at that position directly | [CODE] not in the README |
| **left click** (mouse) | selects and opens the card under the cursor | [CODE] not in the README |
| `Ctrl-C` (once) | **arms** the quit — shows *"press ⌃C again to quit"* | README |
| `Ctrl-C` (twice, <2s) | quits to the shell — the ONLY screen where quitting exits everything | README |
| `Ctrl-f …` | jump chord (same as in tmux — see above), also works standing on Projects | [CODE] |

### Project settings (`,`) — **2 columns, not 1**

`h`/`l` (or `←`/`→`) switch **column**; `↑↓`/`k j` switch row (project); `space`/`⏎`
toggles the selected cell. The columns are:

| column | what it toggles | values | source |
|---|---|---|---|
| **AUTO-NUDGE** | whether a worker that finishes/needs help wakes the master | `on` / `off` | README (the only one it mentions) |
| **BUDGET LIMIT** | whether the budget governor (`fleet-governor`) can park workers once usage hits the ceiling | `enforced` / `ignored` | **[CODE] — not in the README at all.** This is the visual toggle for what the README only describes as touching the `governor-off` file by hand. |

`Esc`/`` ` ``/`Ctrl-C` closes the settings screen, no confirmation needed.

### "+ add project" screen — a folder browser, not a text prompt

| key | what it does |
|---|---|
| `↑↓` / `k j` | move selection between subfolders |
| `→` / `l` / `⏎` | enter the selected folder |
| `←` / `h` | go up one level (parent folder) |
| `s` / `S` | **select THIS folder** as the project root (not a subfolder — the one you're looking at) |
| `Esc` / `` ` `` / `Ctrl-C` | cancel |

[CODE] — the README only says "`+ add project` browses to a root folder", without
explaining it's a keyboard-navigable mini file browser.

---

## 3. The session grid (Node TUI, `onKey`, `mode === 'grid'`)

| key | what it does | source |
|---|---|---|
| `↑↓←→` / `hjkl` | move selection | README |
| `⏎` | enters the selected session in full | README |
| `n` | new session on a checkout — **resumes** if a conversation already exists there | README + [CONFIRMED] nuance |
| `N` | new session, conversation **forced blank** | README + [CONFIRMED] nuance |
| `x` / `X` | asks for confirmation (`y`/`Y`) to kill the session | README |
| `s` / `S` | schedule a message to that session | README |
| `q` / `` ` `` / `Ctrl-C` | back to master (**one press**, no arming like on Projects) | README |
| **digit `1`-`9`** | insta-jump: opens the card at that position directly | [CODE] not in the README |
| **left click** (mouse) | selects and opens the card under the cursor | [CODE] |
| `Ctrl-p` or `Q` (uppercase) | **jumps straight to Projects**, without going back through master first | [CODE] not in the README — `Q` is a fallback for when zellij still owns `Ctrl-p` |
| **`p`** (lowercase) | **pauses** the selected session (`fleet-pause`) — directly from the grid, no Bash needed | **[CODE] — not in the README at all** |
| **`P`** (uppercase) | **resumes** the selected session (`fleet-resume`) — directly from the grid | **[CODE] — not in the README at all** |
| `,` | opens **per-session** settings (individual auto-nudge toggle — see below, and now also rename) | [CODE] — the README only describes the Projects `,`, not that the grid has its own per-session one too |
| `Ctrl-f …` | jump chord (same as in tmux) | README (summarized) |

### Live sessions vs. free worktrees — cards look different

A worktree of the current project with **no live session** on it shows up as its own
card too — not just after pressing `n`. It's styled distinctly (grey border, `· FREE`
status) and shows its branch and the task it was spun up for (via `fleet-spawn`), or
`(no session yet)`. Selecting one and pressing `⏎`/a digit attaches **directly** with
its own name — no naming prompt, that's only for the "+ new session" flow (see below).
[Not upstream yet — added locally, see the fork's PR.]

### Per-session settings (`,` on the grid)

`↑↓`/`k j` move between sessions; `space`/`⏎` cycles that specific session's push
(`notify-lead`) override — more specific than the Projects screen's per-project toggle
(wins over it, per the precedence in `hooks/fleet-event.sh`). `Esc`/`q`/`` ` `` closes.

**`r` — rename** [not upstream yet — added locally, see the fork's PR]: opens a rename
screen for the selected session, pre-filled with its current name, fully editable
(same operation as running `fleet-rename <session> <new-name>` from a shell — the
grid shells out to that exact script). Confirming with `⏎`:
1. Moves the worktree folder on disk (`git worktree move`) — branch untouched.
2. Renames the tmux session — the card updates immediately.
3. Migrates anything keyed by the old name: the pause marker, the notify-lead
   override, a pending scheduled send, and the `fleet-spawn` manifest row (what
   `fleet-worktrees` shows as the task) — none of that silently resets.

Refuses (with the reason shown on screen) if the new name collides with a live
session or an existing folder, or if `git worktree move` itself fails (e.g. the
worktree has uncommitted changes git won't move without `--force`, which this
deliberately doesn't pass).

### "New session" screen (checkout picker, after `n`/`N`)

| key | what it does |
|---|---|
| `↑↓` / `k j` | choose which checkout/worktree to open a session in |
| `⏎` | confirms → lands on the **naming** screen below |
| `Esc` / `q` / `` ` `` | cancel, back to the grid |

#### Naming screen (after `⏎` on a checkout) [not upstream yet — added locally]

| key | what it does |
|---|---|
| typed text | edits the session name, pre-filled with the checkout's basename |
| `Backspace` | deletes the last character |
| `⏎` | confirms and creates the session with that name (resuming or blank, depending on `n` vs `N`) |
| `Esc` / `` ` `` | cancels, back to the checkout list |

A name that collides with a live session still gets `-2`/`-3` appended automatically —
same safety net as before, just starting from whatever you typed instead of forcing
the checkout's basename.

### "Schedule a message" screen (`s` on the grid or Projects)

| key | what it does |
|---|---|
| typed text | builds up `<time> \| <message>` (e.g. `3:50am \| continue`) |
| `Backspace` | deletes the last character |
| `⏎` | confirms — empty + `⏎` **cancels** a pending schedule instead of creating one |
| `Esc` / `` ` `` | cancels without saving |

---

## 4. `fleet-*` commands (recap)

| command | for |
|---|---|
| `fleet-worktrees` | inventory of worktrees + which are free |
| `fleet-list` | live sessions + status |
| `fleet-inbox` | who needs attention / who finished |
| `fleet-spawn <n> --new --prompt "..."` | isolated worker (new worktree) |
| `fleet-spawn <n> --reuse <wt>` | reuse a free worktree |
| `fleet-send <s> "..."` | new task (only if the session is free) |
| `fleet-read <s> [n]` | a worker's last N messages |
| `fleet-answer <s> "2"` | unblock a dialog — don't use `fleet-send` for this |
| `fleet-pause <s>` / `fleet-resume <s>` | CLI equivalents of `p`/`P` on the grid |
| `fleet-stop <s>` | shut down for good + clear its state |
| `fleet-rename <s> <new-name>` | CLI equivalent of the grid's `r` — renames the session AND moves its worktree folder, migrating pause/notify-lead/schedule/manifest state | [Not upstream yet — added locally, see the fork's PR.] |
| `fleet-cycle next\|prev <socket-path> [session]` | what `S-Right`/`S-Left` call — steps the attached client along the ring | [UPSTREAM] |
| `fleet-awake [-d\|--display] [pid]` / `fleet-awake --status` | idle-sleep inhibitor the control plane arms automatically (see §1) | [UPSTREAM] |
| `ghostfleet <profile> --new` | create an empty projects list for a new profile — an unknown profile is otherwise **refused**, not silently created | [UPSTREAM] |

---

## 5. Non-obvious behaviors

- **`claude-here` resumes by checkout**: a new session in a directory with a prior
  conversation resumes it, unless `CLAUDE_FLEET_FRESH=1` (`N`) or a new worktree
  (`fleet-spawn`).
- **Two project-registration conventions** [CONFIRMED, undocumented]: `fleet-project
  add <repo>` registers the repo itself; the "+ add project" picker expects a
  container folder. `route_to_owner` only works correctly with the second — bug
  patched in part (see the fork's PR). The grid's checkout discovery (`n`/`N`'s
  picker, and the free-worktree cards) now asks git directly instead of scanning a
  guessed directory, so it works with either convention.
- **The project settings screen has 2 toggles, not 1** (see above: AUTO-NUDGE and
  BUDGET LIMIT) — the README only describes the first.
- **Pause/resume without touching Bash**: `p`/`P` on the grid are direct shortcuts to
  `fleet-pause`/`fleet-resume` — no need to drop to a shell to manage budget.
- **An unknown profile is refused, not conjured empty** [UPSTREAM]: `ghostfleet
  <name>` where `<name>` isn't a known project OR profile now errors out, naming
  which profile actually holds a project by that name if one does (the classic typo
  vs. "that's a personal-profile project" confusion) — pass `--new` to deliberately
  create one.
- (add here whatever the author explains next…)

---
*Last updated: full audit of `bin/fleet-grid.mjs`, `tmux/cf.tmux.conf`, `bin/fleet-cycle`,
`bin/fleet-awake`, plus the naming/free-card/rename additions from the fork's PR.*
