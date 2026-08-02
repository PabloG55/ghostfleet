# Stack: several sessions on screen at once

**Status:** design + measured constraints. Branch `feat/stack-view`.

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

## Open questions

1. Does `fleet-agent busy` still read a stacked session's pane correctly? Detection
   captures `-t <session>`, which is server-side and shouldn't care about clients — but
   the pane is now narrower, and every busy regex was measured at full width. **Check
   the detectors against a narrow pane before trusting a stacked card's status.**
2. Does the governor's usage scrape survive the reflow? Same question: it greps a status
   line that may wrap at 50 columns.
3. What happens when a stacked session is killed, paused by the governor, or renamed
   underneath the stack?

Answer 1 and 2 before the UI work. A stack that quietly breaks status detection would
undo the thing the fleet is for.
