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

| screen | width | paint ms | data ms | reads in 10 s | KB in 10 s | reads/min idle | reads/min hidden | shift score | furthest move px |
|---|---|---|---|---|---|---|---|---|---|
| home | 390 | 16 | 643 | 16 | 26.3 | 80 | 0 | 0 | 0 |
| project | 390 | 15 | 331 | 17 | 35.0 | 92 | 0 | 0 | 0 |
| session | 390 | 18 | 340 | 27 | 74.6 | 148 | 0 | 0.001 | 97 |
| map | 390 | 14 | 638 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| reviews | 390 | 12 | 1843 | 25 | 52.9 | 144 | 0 | 0 | 0 |
| queue | 390 | 7 | 322 | 17 | 22.9 | 96 | 0 | 0 | 0 |
| search | 390 | 9 | 2160 | 21 | 32.9 | 104 | 0 | 0 | 0 |
| activity | 390 | 14 | 311 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| automations | 390 | 15 | 313 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| settings | 390 | 8 | 323 | 14 | 20.7 | 76 | 0 | 0 | 0 |
| stacks | 390 | 11 | 2146 | 21 | 32.9 | 104 | 0 | 0 | 0 |
| home | 1280 | 7 | 634 | 16 | 26.3 | 80 | 0 | 0 | 0 |
| project | 1280 | 7 | 317 | 17 | 35.0 | 92 | 0 | 0 | 0 |
| session | 1280 | 13 | 337 | 27 | 74.6 | 148 | 0 | 0 | 97 |
| map | 1280 | 7 | 630 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| reviews | 1280 | 7 | 1836 | 25 | 52.9 | 144 | 0 | 0 | 0 |
| queue | 1280 | 15 | 332 | 17 | 22.9 | 96 | 0 | 0 | 0 |
| search | 1280 | 8 | 2156 | 21 | 32.9 | 104 | 0 | 0 | 0 |
| activity | 1280 | 7 | 322 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| automations | 1280 | 15 | 313 | 13 | 18.3 | 72 | 0 | 0 | 0 |
| settings | 1280 | 8 | 321 | 14 | 20.7 | 76 | 0 | 0 | 0 |
| stacks | 1280 | 7 | 2149 | 21 | 32.9 | 104 | 0 | 0 | 0 |

The one move left is the session's "More" button going 97 px sideways when Interrupt and Pause
arrive beside it. Nothing moves down: the header's height, the tabs and the conversation hold.
That button moves the same way whenever a session starts or stops working.

A first-ever launch has no remembered heights, so Settings (15 px) and the Live map on a phone
(62 px) still move once, the first time each is opened on a device.

Polling with the page hidden was already 0 before; what is new is one read at the moment the
page is shown again instead of waiting for each interval to come round.

## Processes the daemon starts

A scratch fleet-serve on its own port, home and tmux servers: five projects of two sessions,
three enrolled devices for 60 s. Each asks for the project list and the digest every 5 s and
pending sign-ins every 3 s; two also read one project's grid every 3 s. Counted by a preload
in the daemon and every node it starts, plus stand-ins for tmux, git and jq on its PATH.

| | processes in 60 s | grid runs | digest runs | tmux | 
|---|---|---|---|---|
| before | 9124 | 220 | 36 | 4956 |
| after, same requests | 3737 | 68 | 36 | 2001 |
| after, as the new client asks (`?rollup=0`) | 1616 | 20 | 12 | 912 |

What is left is the grid itself: about fifty processes a run for a fleet of two sessions.

## Screens

Reads held 2 s. `*-loading.png` is mid-load, `*-loaded.png` ten seconds later, at 390 and 1280:
`home`, `session`, `settings`.
