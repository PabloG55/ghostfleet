# Loading skeletons and read cost: what was measured

Taken with `test/helpers/screen-measure.mjs`, the same instrument on both builds: fixture mode,
every fixture read held 300 ms, each screen opened cold in a page of its own, on a returning
device (every screen visited once first, so anything a client keeps on the device is there).

- **paint**: ms from the lock opening to the first frame with a page in it
- **data**: ms until nothing on the screen says it is waiting
- **reads / KB**: reads made in the first 10 s, and their bytes
- **idle / hidden**: reads a minute once settled, in front and with another tab in front
- **shift / move**: the browser's layout-shift score summed after the first frame, and the
  furthest any one block was moved, in px

Fixture mode overstates reads: the demo reads a grid per project where a daemon answers one
call. The before and after columns are comparable to each other, not to a real server.

## Before (staging at 94eaf6a)

| screen | width | paint ms | data ms | reads in 10 s | KB in 10 s | reads/min idle | reads/min hidden | shift score | furthest move px |
|---|---|---|---|---|---|---|---|---|---|
| home | 390 | 17 | 2160 | 26 | 39.1 | 140 | 0 | 0.07 | 122 |
| project | 390 | 16 | 331 | 27 | 47.8 | 152 | 0 | 0 | 0 |
| session | 390 | 14 | 330 | 37 | 87.4 | 212 | 0 | 0.028 | 28 |
| map | 390 | 16 | 2147 | 23 | 31.1 | 132 | 0 | 0.004 | 24 |
| reviews | 390 | 7 | 1834 | 35 | 65.7 | 204 | 0 | 0 | 0 |
| queue | 390 | 15 | 330 | 27 | 35.7 | 156 | 0 | 0 | 0 |
| search | 390 | 9 | 1845 | 39 | 60.3 | 244 | 0 | 0.003 | 35 |
| activity | 390 | 6 | 321 | 23 | 31.1 | 132 | 0 | 0 | 0 |
| automations | 390 | 15 | 314 | 23 | 31.1 | 132 | 0 | 0.005 | 35 |
| settings | 390 | 8 | 321 | 29 | 40.0 | 156 | 0 | 0.016 | 33 |
| stacks | 390 | 8 | 2150 | 39 | 60.3 | 228 | 0 | 0.042 | 49 |
| home | 1280 | 7 | 2136 | 26 | 39.1 | 140 | 0 | 0.03 | 82 |
| project | 1280 | 14 | 329 | 27 | 47.8 | 152 | 0 | 0.004 | 34 |
| session | 1280 | 14 | 324 | 37 | 87.4 | 208 | 0 | 0.011 | 82 |
| map | 1280 | 7 | 2150 | 23 | 31.1 | 132 | 0 | 0.004 | 34 |
| reviews | 1280 | 12 | 1845 | 35 | 65.7 | 204 | 0 | 0.004 | 34 |
| queue | 1280 | 15 | 331 | 27 | 35.7 | 156 | 0 | 0.004 | 34 |
| search | 1280 | 14 | 1848 | 39 | 60.3 | 236 | 0 | 0.005 | 35 |
| activity | 1280 | 12 | 313 | 23 | 31.1 | 132 | 0 | 0.004 | 34 |
| automations | 1280 | 15 | 314 | 23 | 31.1 | 132 | 0 | 0.007 | 35 |
| settings | 1280 | 13 | 313 | 29 | 40.0 | 156 | 0 | 0.011 | 34 |
| stacks | 1280 | 7 | 2136 | 39 | 60.3 | 228 | 0 | 0.028 | 49 |

## After

On the build merged with staging (client v118). The session screen, the one screen the next
merge changed (the composer, around a keyboard), was measured again on v119 and gave the same
row at both widths: 146 reads a minute idle, 0 hidden, 0 moved. The last column is measured directly, not by
the browser: everything drawn while the screen said it was waiting, and how far it had moved
once the data was in (see the session header section for why both are kept).

| screen | width | paint ms | data ms | reads in 10 s | KB in 10 s | reads/min idle | reads/min hidden | shift score | furthest move px | drawn waiting, moved px |
|---|---|---|---|---|---|---|---|---|---|---|
| home | 390 | 9 | 632 | 16 | 26.3 | 70 | 0 | 0 | 0 | 0 |
| project | 390 | 8 | 319 | 17 | 35.0 | 92 | 0 | 0 | 0 | 0 |
| session | 390 | 14 | 346 | 27 | 74.6 | 146 | 0 | 0 | 0 | 0 |
| map | 390 | 12 | 633 | 13 | 18.3 | 82 | 0 | 0 | 0 | 0 |
| reviews | 390 | 7 | 1856 | 25 | 52.9 | 144 | 0 | 0 | 0 | 0 |
| queue | 390 | 13 | 329 | 17 | 22.9 | 96 | 0 | 0 | 0 | 0 |
| search | 390 | 8 | 2153 | 21 | 32.9 | 104 | 0 | 0 | 0 | 0 |
| activity | 390 | 13 | 310 | 13 | 18.3 | 72 | 0 | 0 | 0 | 0 |
| automations | 390 | 7 | 319 | 13 | 18.3 | 72 | 0 | 0 | 0 | 0 |
| settings | 390 | 9 | 323 | 14 | 20.7 | 76 | 0 | 0 | 0 | 0 |
| stacks | 390 | 8 | 2137 | 21 | 32.9 | 104 | 0 | 0 | 0 | 0 |
| home | 1280 | 12 | 632 | 16 | 26.3 | 80 | 0 | 0 | 0 | 0 |
| project | 1280 | 8 | 325 | 17 | 35.0 | 92 | 0 | 0 | 0 | 0 |
| session | 1280 | 16 | 337 | 27 | 74.6 | 146 | 0 | 0 | 0 | 0 |
| map | 1280 | 15 | 637 | 13 | 18.3 | 72 | 0 | 0 | 0 | 0 |
| reviews | 1280 | 16 | 1848 | 25 | 52.9 | 144 | 0 | 0 | 0 | 0 |
| queue | 1280 | 14 | 330 | 17 | 22.9 | 96 | 0 | 0 | 0 | 0 |
| search | 1280 | 11 | 2162 | 21 | 32.9 | 104 | 0 | 0 | 0 | 0 |
| activity | 1280 | 6 | 318 | 13 | 18.3 | 72 | 0 | 0 | 0 | 0 |
| automations | 1280 | 11 | 310 | 13 | 18.3 | 72 | 0 | 0 | 0 | 0 |
| settings | 1280 | 16 | 332 | 14 | 20.7 | 76 | 0 | 0 | 0 | 0 |
| stacks | 1280 | 7 | 2137 | 21 | 32.9 | 104 | 0 | 0 | 0 | 0 |

A first-ever launch has no remembered heights, so Settings and the Live map on a phone still
move once, the first time each is opened on a device (`--first`, which skips the visit that
would teach them):

| screen | width | furthest move px | drawn waiting, moved px |
|---|---|---|---|
| settings | 390 | 15 | 16 (the panels under Notifications, then under Paired machine) |
| settings | 1280 | 15 | 16 (the panels under Notifications, then under Paired machine) |
| map | 390 | 62 | 63 (the ticker under the sea) |
| map | 1280 | 0 | 0 |

Both are left. What the shape would have to know is the answer itself: whether Notifications is
a switch or a line saying why there is none (fixture mode answers with the line, a daemon with
the switch, and the panel is 15 px shorter for the line), how many machines are paired, and how
many islands the sea holds.
A guess that suits one answer moves for the other, on every device and not only the first time,
which is why the height a device last saw is what they keep.

Polling with the page hidden was already 0 before; what is new is one read at the moment the
page is shown again instead of waiting for each interval to come round.

## The session header, state by state

The header is drawn before the session's card arrives, and what its controls row holds is the
card's to say: Interrupt and Pause for a working session, Resume for a parked one, Wake or Reopen
for an asleep or lost one, nothing for an idle lead. Every session the two grids offer, opened
cold with reads held 300 ms (`--sessions --fixture <grid> --idle 0`). Each cell is
`far / drawn waiting, moved` in px, and what moved:

- **far** is the furthest move the browser's layout-shift entries report
- **drawn waiting, moved** is measured directly: everything visible at the moment the screen
  first says it is waiting is recorded, and its position compared once nothing says so. The
  layout-shift API names at most a few sources per shift, and was silent about More twice.
  Animated elements (a ship under way) are skipped

Before, at 948c405:

| session (grid-acme-api) | state | 390 | 1280 |
|---|---|---|---|
| master | ready, lead | 28 / 82 More | 82 / 82 More |
| api-fix | working | 97 / 98 More | 97 / 98 More |
| docs-pass | ready | 0 / 0 | 0 / 0 |
| types | ready, label and schedule | 5 / 5 controls | 0 / 0 |
| list-pages | working | 28 / 98 More | 97 / 98 More |
| rate-limit | starting | 0 / 1 ship | 0 / 1 ship |
| csv-export | ready | 28 / 28 controls | 0 / 0 |

| session (grid-degraded) | state | 390 | 1280 |
|---|---|---|---|
| master | needs you, lead | 28 / 82 More | 82 / 82 More |
| api-fix | needs you | 9 / 0 | 0 / 0 |
| docs-pass | limit | 9 / 0 | 0 / 0 |
| csv-export | interrupted | 9 / 1 tabs | 0 / 0 |
| rate-limit | parked | 11 / 12 More | 11 / 12 More |
| adapter-probe | unknown | 9 / 1 tabs | 0 / 0 |
| docs-sweep | idle | 28 / 28 controls | 0 / 0 |

After, two runs each, a third on the build merged with staging and a fourth on v119:
**nothing drawn while
waiting moves, for any of the fourteen at either width** (0 in the second column everywhere), and the first column is 0 everywhere except
grid-degraded at 390, where it is 9 on every session, before and after: the brand, below.

The controls are drawn as one shape until the card lands and the state is known. Before the
card, the state can come from the conversation read, which can land first. A working session
then drew Interrupt beside the shape, and Interrupt slid 82 px along the row when the shape
went: two loads in six. More sits at the row's end in a box of its own, so nothing the state
adds can push it. At 1280 the meta line (state, branch, PR, label, schedule) had moved 10 to
39 px with the width of the state's pill. The pill is now the first thing on that line, so its
width moves nothing drawn before it.

The one move left on that screen is outside the header: with grid-degraded at 390, the brand in
the top bar moves 9 px when a "needs you" count appears at the bar's right end. The bar spaces
its three parts apart rather than centring the brand on the page, so the count pushes it. That
is the shell's top bar, and measured on every screen with grid-degraded at 390 it is 9 px on all
of them and on nothing at 1280. It is left for its own change.

`phone-check` holds the grid 1.5 s longer than the conversation for the same five sessions
(working, an idle lead, a label and schedule, parked, interrupted). It asserts that the header
is still the shape, with no control beside it, once the conversation has landed, and that
nothing it had drawn has moved once the card does. On 948c405's build 26 of its rows are red.

## Processes the daemon starts

A scratch fleet-serve on its own port, home and tmux servers: five projects of two sessions,
three enrolled devices for 60 s. Each asks for the project list and the digest every 5 s and
pending sign-ins every 3 s; two also read one project's grid every 3 s. Counted by a preload
in the daemon and every node it starts, plus stand-ins for tmux, git and jq on its PATH.

| | processes in 60 s | grid runs | digest runs | tmux | 
|---|---|---|---|---|
| before | 9124 | 220 | 36 | 4956 |
| after, same requests | 3737 | 68 | 36 | 2001 |
| after, as the new client asks (`?rollup=0`) | 1676 | 20 | 12 | 912 |

What is left is the grid itself: about fifty processes a run for a fleet of two sessions.

A grid is kept 2.5 s, and a write to that fleet drops it. A read that decides what to do asks
for `fresh=1` and is answered with a run of its own, which then replaces the kept one. The
phone bringing a lead up is such a read: it chooses between reopen, wake, resume and start from
what the grid says. Through the keep, a lead that went lost outside the daemon a moment ago
read as up, so nothing was done and the phone said the lead was ready.

Of pending sign-ins only the account half is kept: a tmux call per fleet and a pane capture per
session. The records are a directory read written by other processes, so they are read every
time. A push watch, this machine's or a paired one's asking on its behalf, reads the account
half fresh. A keep in front of it hid every state shorter than 3 s, so an account that
expired, recovered and expired again rang once.

## Screens

Reads held 2 s. `*-loading.png` is mid-load, `*-loaded.png` ten seconds later, at 390 and 1280:
`home`, `session`, `settings`.
