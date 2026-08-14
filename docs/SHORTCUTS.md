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
| `Ctrl-t` (no prefix) or `Ctrl-a t` | **terminal tab** on this session's own folder — a login shell in `#{pane_current_path}`, so it follows you if you've cd'd inside the repo | [CODE] `bin/fleet-tab` |
| `Ctrl-n` (no prefix) or `Ctrl-a n` | **editor tab** on the same folder — `$EDITOR` (default `nvim .`); override with `CLAUDE_FLEET_EDITOR` | [CODE] `bin/fleet-tab` |
| `Ctrl-x` (no prefix) or `Ctrl-a x` | the **stack** screen. It lived on `Ctrl-t` until tabs took that key | [CODE] |
| **drag with the mouse** | **selects and copies to the system clipboard**, no prefix and no modifier — the way zellij does it. Double-click copies a word, triple-click a line | [CODE] `bin/fleet-copy` |

### Why drag-to-copy needed code at all

`mouse on` is what creates the problem: tmux captures the drag, so the terminal's own
selection never happens and what you highlight goes into tmux's *private* buffer. It
looks selected and it is not on your clipboard — the only way out was holding a
per-terminal modifier (⌥ on macOS Terminal/iTerm) to bypass tmux, which nobody
discovers. `bin/fleet-copy` picks the right clipboard tool at run time (`pbcopy` /
`wl-copy` / `xclip` / `xsel` / `clip.exe`), because `pbcopy` is macOS-only and this repo
supports Linux and WSL. `set-clipboard on` additionally sends an OSC 52 copy, which is
what carries a selection back to **your** machine when the fleet is over SSH.

The stack gets the drag binding too, but **not** the double/triple-click ones: in there
a click focuses a pane, and that is pinned by a test.

### Tabs (`Ctrl-t` / `Ctrl-n`)

A tab is **another session on the same fleet socket**, named `_term-<session>` /
`_edit-<session>` — not a tmux window. That is load-bearing twice over:

- **Why not a window.** Every status reader here captures with `capture-pane -t
  "$SESSION"`, which resolves to the session's *current* window. A shell window would
  make the grid read the shell instead of the agent, the governor park a working
  session, and `fleet-send` paste your prompt into the shell — silently.
- **Why the `_`.** It marks them as not-workers (`is_tab` in `fleet-governor`,
  and the refusal in `fleet-send`). It is an underscore and not a `+` because a leading
  `+` is tmux target syntax for "next session" — see CLAUDE.md.

Unlike every other chord in this table, tabs **do not detach**: they're on the same
server, so you land there instantly. One tab per kind per session, reused — pressing
`Ctrl-t` twice returns you to the terminal you already have.

**Back from a tab goes to the session you came from**, not up to the grid — a tab is
opened *out of* a chat, so detaching would be one level further than you asked for.
`fleet-tab` records the origin on the tab session (`@cf_tab_from`) and the back key
branches on it, so every other session keeps the plain detach it always had. If the
origin has since been closed, back falls through to a detach rather than leaving the key
doing nothing.

**A tab is not a card.** It's a real session — that's what stops the fleet reading it as
an agent pane — but it's hidden from the grid, the cycle ring and the card numbering.
It has to be: a card claims a *number*, so a terminal renumbered every session behind it,
and because a tab shares its origin's cwd the transcript lookup handed it the origin's
last message — a terminal card reading "✓ ready" over work it had no part in.

Its status bar names the origin and the project (`● ⌨ master · ghostfleet`) rather than
the bare session name, which is the one thing you already know.

`Ctrl-n` needs zellij's own `Ctrl-n` (resize mode) unbound, which `layouts/fleet.kdl`
now does — but **zellij only reads keybinds when a session is created**, so an already
open fleet keeps swallowing it until you start a new zellij session.
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

So: `Ctrl-f 1 1` = project 1, session 1. `Ctrl-f 1 ⏎` (or `Ctrl-f 1 m`) = project 1's
master. `Ctrl-f 1 s` = project 1's grid. `Ctrl-f s 1` = the same, short form.
`Ctrl-f p` = Projects.
[CODE] — the README only summarizes this in one comment line in `bin/ghostfleet`,
without detailing the sub-steps or that `Escape` cancels at any level.


### Knowing when a worktree is finished

`fleet-worktrees` marks a worktree **DONE** when its PR is merged, it has no session and
its tree is clean — and `fleet-inbox` repeats that as a footer, including on the
`inbox: nothing new` path, because that is the answer a lead sees most often. Nothing is
deleted automatically; the lead runs `fleet-clean --go`.

`fleet-stop <session> --reclaim` is the one-command version for a single worker: it
stops the session and removes its worktree, delegating the "is that safe" decision to
`fleet-clean --only` so there is exactly one set of gates. If it is not safe the session
still stops and the worktree is kept with the reason printed. Agents reach it as
`fleet_stop(reclaim: true)`.

**"Finished" cannot be asked of git.** A squash-merge lands one *new* commit, so the
branch's own commits are never in `main` and every reachability test — `rev-list --not
--remotes`, `git cherry`, `branch --merged` — reports shipped work as unlanded. Measured
on one fleet: 16 of 17 worktrees were refused as holding "unpushed local commits" while
every one of their PRs was merged. `bin/fleet-merged` asks GitHub instead and caches the
answer (10 min, `CLAUDE_FLEET_MERGED_TTL`). When it cannot tell — no `gh`, no network, no
PR — it prints nothing, and every caller falls back to the conservative git checks. That
direction matters: this list makes cleanup *more* willing, so silence must never read as
"nothing merged".

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
| `Ctrl-x` | the **stack** screen, from anywhere — Projects, master, the grid, or inside a session. (It was `Ctrl-t` everywhere until tabs took that key; the Projects screen kept its own copy of the binding, which is why it lagged behind the others for a while) |
| `Ctrl-t` / `Ctrl-n` | a **terminal / editor tab at the selected project's root**, without booting its master first — you often want a shell in a repo, not a Claude session in it. Opens the project's tmux server if it has never been entered |
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
| `⇧h` `⇧j` `⇧k` `⇧l` (`H J K L`) | **reorders** the selected session's card (persisted per fleet — see below) | README |
| `⏎` | enters the selected session in full | README |
| `n` | new session on a checkout — **resumes** if a conversation already exists there | README + [CONFIRMED] nuance |
| `N` | new session, conversation **forced blank** | README + [CONFIRMED] nuance |
| `w` / `W` | **new worktree** — a form (name · branch · from · agent), then `fleet-spawn --new` creates it and you land in the session (see below) | README |
| `x` / `X` | asks for confirmation (`y`/`Y`) to kill the session — or, on a `· FREE` card, to **remove that worktree** | README |
| `s` / `S` | schedule a message to that session | README |
| `q` / `` ` `` / `Ctrl-C` | back to master (**one press**, no arming like on Projects) — and it is master *however you reached the grid*, including `Ctrl-s` from Projects and the `Ctrl-f` jumps, which skip master on the way in. It used to depend on that: entering the grid without master meant backing out ejected you two levels, past the master of the project you were plainly still inside. `Ctrl-p` remains the express lane up. | README |
| **digit `1`-`9`** | insta-jump: opens the card at that position directly | [CODE] not in the README |
| **left click** (mouse) | selects and opens the card under the cursor | [CODE] |
| `Ctrl-p` or `Q` (uppercase) | **jumps straight to Projects**, without going back through master first | [CODE] not in the README — `Q` is a fallback for when zellij still owns `Ctrl-p` |
| **`t`** / **`T`** / `Ctrl-x` | opens the **stack** screen — several sessions on screen at once, across projects (see §3b) | [not upstream yet — `feat/stack-view`] |
| `Ctrl-t` | **terminal tab** on the selected card's folder (the project root when the selection isn't a session). Creates or reuses it, then attaches — same key, same meaning, as inside a session | [CODE] `tabChoice` |
| `Ctrl-n` | **editor tab** on the same folder | [CODE] `tabChoice` |
| **`p`** (lowercase) | **pauses** the selected session (`fleet-pause`) — directly from the grid, no Bash needed | **[CODE] — not in the README at all** |
| **`P`** (uppercase) | **resumes** the selected session (`fleet-resume`) — directly from the grid | **[CODE] — not in the README at all** |
| `,` | opens **per-session** settings (individual auto-nudge toggle — see below, and now also rename) | [CODE] — the README only describes the Projects `,`, not that the grid has its own per-session one too |
| `Ctrl-f …` | jump chord (same as in tmux) | README (summarized) |

### Card order is the fleet's numbering (`⇧hjkl`)

`⇧hjkl` moves the selected session's card the way it does on the Projects screen, but
the stakes are higher here: **four** things count this same list — the digit printed on
each card, the `1`-`9` insta-jump, `Ctrl-f <project> <session>`, and `⇧←→` cycling. They
have to keep agreeing, so the order is written to `$CLAUDE_FLEET_DIR/<sock>.order` *and*
mirrored onto the tmux server as the `@cf_order` option (colon-separated — tmux allows
neither `:` nor `.` in a session name, so no name can smuggle a separator through).

The two copies exist because `⇧←→` runs `fleet-cycle` inside a tmux `run-shell`, which
inherits the *server's* environment rather than the fleet's and so cannot find the file
at all. `bin/ghostfleet` resolves `Ctrl-f <p> <s>` by asking the grid itself
(`fleet-grid.mjs --order`), so there is exactly one implementation of the ordering and
one consumer of the mirror. Sessions the file has never seen sort last, in tmux's own
order; names in the file with no live session are skipped rather than counted.

### `w` — a brand-new worktree

A four-field form (the `agent` row only appears when more than one agent is installed):
`name` (the session and the folder), `branch` (blank = same as the name), `from` (base
ref, pre-filled with the repo's current branch), `agent`. `⏎` hands the whole job to
`bin/fleet-spawn <name> --new`, run with its cwd set to the project's **main checkout** —
spawn finds the repo from `$PWD`, and the control plane's own cwd is somewhere else
entirely. That reuse is the point: base-ref resolution against the upstream, the
`node_modules` symlink, the manifest entry and the agent marker all come for free and
can't drift from what a lead session gets. The grid then attaches the session **spawn
says it started**, not the name that was typed — spawn settles collisions itself
(`name~2`), and attaching the wrong one would be silent.

`x` on a `· FREE` card runs `git worktree remove`. The **branch is deliberately left
alone**. A dirty tree makes git refuse; the refusal is shown and forcing past it takes
`f`, not a second `y` — a second `y` on a prompt that just failed is a reflex, and this
one discards real work.

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

## 3b. The **stack** screen (`t` on the grid) — sessions side by side

Lists every live session in **every project of this profile**, not just the one whose
grid you came from — watching one project's worker next to another's is the point.

| key | what it does |
|---|---|
| `↑↓` / `k j` | move between sessions (project headers are skipped) |
| `space` | add/remove the selected session from the stack (`[✓]` marks members) |
| `⏎` | open the stack — one pane per member, even horizontal split |
| `c` | clear the stack |
| `Esc` / `q` / `` ` `` | back to the grid |

Membership persists in `$CLAUDE_FLEET_DIR/stack.tsv` as `sock<TAB>session`, so it
survives leaving the screen. Socket-scoped, for the reason every marker in this repo is:
every project has a session called `master`.

### Inside the stack — a THIRD level of multiplexer

zellij → the stack's tmux → each project's fleet tmux → the agent. The **outer** tmux
answers a key first, so the stack's config (`tmux/cf-stack.tmux.conf`) deliberately binds
almost nothing and does **not** load `tmux/cf.tmux.conf`. Verified live:

| key | who answers it, inside a stack pane |
|---|---|
| `` ` `` | **the stack** — leaves the whole stack in one press. (The fleet already takes `` ` `` with `-n`, so nothing new is stolen from the agent, and "one level back" from a stack means "leave the stack".) |
| `Ctrl-a` … | **the fleet**, as everywhere else — `C-a g`/`d`/`s`/`p` and the `C-a C-a` literal escape all still work. The stack has `prefix None` precisely so this keeps working. |
| `S-Left` / `S-Right` | **the stack** — MOVES FOCUS between panes, wrapping at both ends. Until this existed the stack was watch-only past the first pane: `prefix None` puts tmux's own pane navigation (prefix-table only) out of reach, and `mouse off` made the click bindings inert, so focus never left pane 0. |
| `Ctrl-a ←` / `Ctrl-a →` | **the fleet** — cycles *that pane's* nested client to another session in *that* project (what `⇧←→` did before it moved to pane focus; `tmux/cf.tmux.conf` binds both forms, and only the `-n` one was taken). Confirmed: a pane showing `master` stepped to `worker-b`. |
| `Ctrl-s` / `Ctrl-p` / `Ctrl-f` | **the fleet** — they do what they always do (write a `.goto` marker, detach), which here closes that one pane. The marker is harmless: every path that reads one clears it first. |
| everything else | **the agent**. Note `Ctrl-b` is *not* used by the stack — Claude Code uses it to move the cursor back one character, which is why the stack has no prefix of its own. |
| **click** | **both** — the stack focuses the pane you clicked, then forwards the click to the agent in it (tmux's default `MouseDown1Pane` is `select-pane -t = ; send-keys -M`). So clicking a pane is the same as `⇧←→`-ing to it, and Claude still sees the click. |
| wheel / drag | **the agent** — forwarded, because a nested tmux always sets `mouse_any_flag`. Verified the wheel does *not* drop the outer tmux into copy-mode, which is the classic nested-tmux scroll trap. |

Each pane keeps its own session's status bar; the **pane border** carries
`project · session`, because a nested bar reading `● master` can't say whose master it is.
Note that a stacked pane's own status bar still advertises `⇧←→ cycle`: it belongs to the
fleet *inside* the pane, which has no way to know it is being viewed through a stack. Inside
one, that hint means `Ctrl-a ←/→`.

Leaving **detaches** the nested clients and never kills a session (asserted in
`test/run.sh`, and the assertion goes red if the teardown is changed to kill).

Two measured caveats live in `docs/stack-view.md`: the busy detector had to be fixed to
work at stack width, and the governor's 5h usage scrape cannot read a pane narrower than
~100 columns.

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
| `fleet-send --reply-to me <s> "..."` | **ask** instead of dispatch: records a return address, and when that session's turn ends the hook relays its answer into YOUR inbox and wakes you. Works across projects (`-s <sock>`), which is the case it exists for — a plain send's `done` only ever reaches the target's OWN master. [not upstream yet] |
| `fleet-read <s> [n]` | a worker's last N messages |
| `fleet-answer <s> "2"` | unblock a dialog — don't use `fleet-send` for this |
| `fleet-pause <s>` / `fleet-resume <s>` | CLI equivalents of `p`/`P` on the grid |
| `fleet-stop <s>` | shut down for good + clear its state |
| `fleet-rename <s> <new-name>` | CLI equivalent of the grid's `r` — renames the session AND moves its worktree folder, migrating pause/notify-lead/schedule/manifest state | [Not upstream yet — added locally, see the fork's PR.] |
| `fleet-stack members\|add\|remove\|toggle\|clear` | the stack screen's membership, from a shell (`sock<TAB>session` in `$CLAUDE_FLEET_DIR/stack.tsv`) | [not upstream yet — `feat/stack-view`] |
| `fleet-stack open [--dry-run]` | build the stack window and attach. `--dry-run` prints the panes it would create and the nested attach for each, and needs no tty | [not upstream yet] |
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
