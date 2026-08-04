# Stack: several sessions on screen at once

**Status:** built. Branch `feat/stack-view`. The two open questions below were answered
against a real narrow pane before any UI was written, and **question 1 came back
"broken"** — the busy detector could not see a working agent at stack width. That is
fixed in the detector, not worked around in the stack. See *What the measurements
said*, below.

A third screen alongside Projects and the grid: pick sessions, see them side by side in
split panes, work in any of them. The point is watching two workers at once — one
project's session on the left, another's on the right — instead of cycling between
full-screen views.

## The constraint everything else follows from

**Every project is its own tmux server** (`cf-<project>`), and *panes cannot cross
servers*. Measured, not assumed:

```
$ tmux -L stkA join-pane -s b        # b lives on server stkB
can't find pane: b
```

So the obvious implementation — `join-pane` the real session panes into one stack
window — **only works within a single project**, which is exactly the case the request
isn't about. Cross-project stacking has to go through a **nested attach**: a pane on the
stack's server runs `tmux -L <other-sock> attach -t <session>`. That does work:

```
$ tmux -L stkA new-window "tmux -L stkB attach -t b"
nested: tmux          # ✓ the pane hosts the other server's session
```

`join-pane` has a second problem even same-project: it *moves* the pane out of its
session, and a fleet session is one window of one pane — moving it empties the session
and tmux destroys it. Nesting is the only approach that leaves sessions intact.

## The side effect that decides the design

A nested client resizes the target. tmux sizes a window to fit its clients, so attaching
a session into a small stack pane shrinks it — and Claude Code reflows to the new width:

```
b's window before:                200x50
after a 60x20 pane attaches:      60x19      ← the session SHRANK
```

That is fine when the stack pane is the only viewer. It is **not** fine when the same
session is also open full-screen, because the default sizing takes the *smallest* client
and the full-screen view gets cropped to the stack pane's size.

The fix is a server option, and it works — measured with two clients (160x45 and 50x15)
attached to the same session:

```
window-size=smallest   ->  50x14      full-screen view ruined by the stack pane
window-size=largest    ->  160x44     full-screen stays right; the stack pane
                                      shows a cropped viewport of it
```

**So: set `window-size largest` on every fleet server the stack attaches into.** Without
it, opening a stack silently degrades whatever you look at afterwards — the failure is
invisible until you notice Claude is wrapping at 50 columns.

## Shape

- **A screen, like the grid.** Reached from the grid (a key next to `n`), listing live
  sessions with a marker for the ones in the stack. Space adds/removes, `⏎` opens it.
- **The stack itself is a tmux window** on a dedicated socket (`cf-stack`, or the lead's
  server — decide), one pane per stacked session, each running a nested attach.
- **Layout**: even horizontal split to start. Vertical/grid later; don't build a layout
  engine first.
- **Membership persists** in `$CLAUDE_FLEET_DIR/stack.tsv` (`sock<TAB>session`), so the
  stack survives leaving the screen. Socket-scoped for the same reason every other
  marker is: every project has a session called `master`.

## Nesting hazards to settle before building

1. **Prefix collision.** The stack window is tmux, and each pane hosts another tmux.
   `C-a` reaches the outer one; the inner needs `C-a C-a`. Either document that, or give
   the stack server a different prefix. The fleet already nests inside zellij, so this is
   the *third* level — check what still reaches Claude.
2. **`` ` `` and the no-prefix bindings** (`C-s`, `C-p`, ⇧←/→) are bound `-n` on the
   fleet config. Inside a stack pane they'd be caught by whichever tmux sees them first.
   The stack's own config probably must NOT load `tmux/cf.tmux.conf`.
3. **Detaching.** Closing the stack must detach the nested clients, not kill sessions.
   `attach` in a pane that dies leaves the session running — verify, don't assume.
4. **The status bar** renders per session; three nested bars stacked up will be noisy.

## What the measurements said

Method: a real Claude session on its own fleet server, nested into a pane on a second
server, the nesting pane resized through 30–240 columns while the session was given real
work. `fleet-agent busy` and the governor's `pct_of` were then read at each width, in
both directions (working and idle).

### 1. `fleet-agent busy` was BROKEN at stack width — and is now fixed

Not a small miss. At 56 columns, with the agent thinking the whole time, `fleet-agent
busy` reported **idle for 120 consecutive samples over a full minute**.

The cause is not the capture — `capture-pane` is server-side and works fine. It is that
**Claude composes its spinner line to the pane width, and the elapsed-time counter is
the first field it drops.** Same session, same turn, different widths:

```
240  ✶ Forming… (31s · thinking more with xhigh effort)     busy 3/3
 70  · Forming… (21s · still thinking with xhigh effort)    busy 3/3
 62  ✳ Forming… (almost done thinking with xhigh effort)    busy 0/3   <- no timer
 56  ✳ Flowing… (almost done thinking with xhigh effort)    busy 0/3   <- no timer
 50  ✶ Forming… (still thinking with xhigh effort)          busy 0/3   <- no timer
 46  ✳ Forming… (thinking with xhigh effort)                busy 0/3   <- no timer
 30  ✽ Gusting… (thinking)                                  busy 0/3   <- no timer
```

Every alternative the old regex had was width-dependent: `esc to interrupt` and
`↓ N tokens` are dropped even earlier than the timer, and the timer was the only thing
`(…|\.\.\.) ?\([0-9]+[ms]` could anchor on. And there is no fixed threshold to code
around — the phase text *grows* through a turn (`thinking` → `still thinking` →
`almost done thinking`), so a stack pane that reads correctly early in a turn stops
reading correctly later in the same turn, at the same width.

What survives every width is the **shape**: gerund, ellipsis, open paren. A finished
turn is `✻ Cooked for 6s` — no ellipsis — so the two never collide. The regex now
anchors on that; both spellings (`busy_re`, `busy_re_js`) and the grid's inlined copy
were changed together, and `test/run.sh` asserts it against verbatim 56-column captures
in both directions. Two side notes worth keeping:

- **Don't anchor on the spinner glyph.** It renders as a plain `·` often enough to
  matter (`· Forming… (21s …)` above).
- **Plain-text streaming shows no busy indicator at any width** — verified identically at
  50 and 220 columns, so this is pre-existing and *not* a stack regression. During a
  long prose answer the pane carries only the text. The grid still reads such a session
  correctly because it also has the hook and transcript signals; a bare `fleet-agent
  busy` does not.

### 2. The governor's usage scrape does NOT survive a narrow pane

Claude **truncates** its status line to the pane width — it does not wrap — so the 5h
field is not pushed onto a second line, it is gone:

```
130  … | Opus 5 (1M context) | ctx:5% | 18%(4h 4m) | 7d:33%(115h 24m)   -> 18
100  … | Opus 5 (1M context) | ctx:5% | 17%(4h 12…                      -> 17
 90  … | Opus 5 (1M context) | ctx:5% |…                                -> none
 56    pablo@example.com | Example Account | w1 |   HEA…                 -> none
```

There is no fix that keeps the stack useful. Pinning member windows wide
(`window-size manual`) would restore the figure and reduce each stack pane to a sliver
of a cropped session, which is worse than the problem. So this is a **stated
limitation**, with three things done about it:

- `window-size largest` means the figure comes *back* the moment any wider client
  attaches — verified: the same session read `none` with only a 160-column stack pane,
  and `18` with a 200-column client also attached.
- `budget()` takes the max across all of a fleet's sessions, so one unstacked session
  (usually `master`) keeps the ceiling enforced for the whole project.
- when there is genuinely no reading, the governor now **says which panes were too
  narrow and how wide they were**, instead of logging a bare "no budget reading" that is
  indistinguishable from an account at 0%.

Worth knowing: a member window **stays narrow after you leave the stack** (tmux keeps
the last client's size), until something wider attaches. So the blind spot outlives the
screen.

### 3. `prefix None` + `mouse off` left NO way to reach pane 2..N

Hazard 1 above ("check what still reaches Claude") was answered by taking almost nothing:
`prefix None` so `C-a` stays the fleet's, `mouse off` so events pass through, one binding
(`` ` ``). What that combination also does — measured on a live stack, not read — is remove
every way of **moving focus**:

- tmux ships pane navigation *only* in the prefix table (`prefix o`, `prefix ←→`), and
  `prefix None` makes that table unreachable. The root table has nothing but the built-in
  `Mouse*`/`Wheel*` entries — and `mouse off` made those inert.
- `fleet-stack` selects pane 0 before attaching, and nothing afterwards can move it.

So a two-pane stack could *watch* both sessions and only ever type into the left one, which
reads as an unresponsive pane rather than a missing keybinding.

**What `mouse off` was actually doing** — worth writing down, because the first version of
this section got it wrong. It did *not* stop the event reaching the agent. tmux routes a
mouse sequence to the pane **under the cursor** and translates the coordinates for it, and
it propagates a pane's own mouse request outward, so the whole three-level chain carried
clicks with `mouse off` set here. Measured: a click at column 150, in a pane at offset 134,
arrived at that pane's agent reporting **column 16**. What `off` suppressed was only tmux's
`Mouse*` *bindings* — the `select-pane`. So a click in an unfocused stack pane already went
to that pane's Claude while the keyboard stayed behind: the worst of both.

Fixed by binding `⇧←/→` on the stack server to `select-pane -t :.+` / `:.-`. Three notes:

- **It is affordable only because of the prefix table.** `⇧←→` is the one `-n` pair the
  fleet also binds (its session ring), but `tmux/cf.tmux.conf` binds the same commands to
  `C-a ←/→` as well, and `prefix None` passes those straight through. Nothing is lost;
  inside a stack the ring just moves to the prefixed form.
- **`:.+`/`:.-`, not `-L`/`-R`.** The layout is always `even-horizontal`, so pane index
  order *is* left-to-right order — and the index form wraps at both ends, matching the
  fleet's own wrapping ring instead of dead-ending on the edge pane. Verified by driving an
  attached client through all three panes and off both ends (`test/run.sh`).
- **Alt+arrows were the other candidate** and were rejected: they depend on the terminal
  sending Option as Meta. `⇧←→` needs no such assumption — the fleet's existing binding
  already proves those keys arrive.

And `mouse on`, so a **click** focuses the pane you clicked. Measured on tmux 3.7b in the
real nest, with synthetic SGR events fed to a live client, both directions:

| | `mouse off` | `mouse on` |
|---|---|---|
| click focuses that pane | no | **yes** |
| click still reaches the agent | yes, col 150 → `16` | yes, **byte-identical** |
| wheel reaches the agent | yes | yes |
| wheel traps the outer tmux in copy-mode | no | **no** |

So `on` costs nothing. The default `MouseDown1Pane` is `select-pane -t = ; send-keys -M` —
it forwards *after* focusing — and `MouseDrag1Pane`/`WheelUpPane` forward whenever the pane's
app requested mouse tracking (`mouse_any_flag`), which a nested tmux always has. That last
row is the classic nested-tmux scroll trap and it is worth re-checking if these defaults ever
change: an outer tmux that entered copy-mode on a wheel event would freeze the pane's view
and swallow the scroll. Nothing new is asked of zellij at level 1 either — with `off` the
event already had to pass through it to reach the agent, so this only changes what the stack
does with an event it was already receiving.

### 4. Leaving never kills a session — verified, not assumed

Killing the outer stack window SIGHUPs each pane's `tmux attach`, which detaches that
nested client. Measured on two members on two different servers: after leaving, both
sessions are alive at `clients=0`, and the stack server is gone. `test/run.sh` asserts
it, and the assertion goes red if the teardown is changed to kill.

## Still open

- What happens when a stacked session is **killed, paused by the governor, or renamed**
  underneath the stack. Today the pane simply dies (`remain-on-exit off`) and the layout
  reflows; membership keeps the stale row until you toggle it off, and `fleet-stack
  members` prunes dead rows on the next open.
- Vertical / grid layouts. `even-horizontal` only, on purpose.
