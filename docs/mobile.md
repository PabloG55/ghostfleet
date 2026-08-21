# Mobile: the fleet from a phone

**Status:** design only, nothing built. Two decisions are settled: the transport is
Tailscale (§5), and the phone gets the **full verb set**, not a read-only phase (§7).
Every number below was measured on this machine before the design was written, and **two
of the measurements changed the design** — the sleep setting (§8) and the dependency
posture (§6). See those sections before disagreeing with the conclusions.

The fleet is invisible away from the desk. A worker that needs a permission at 9pm waits
until someone opens a terminal, and the thing you actually want to know from a couch or a
café — *is anything blocked on me* — costs a laptop. This is the design for **running**
the fleet from a phone: the same grid, the same cards, the same verbs, including creating
and reclaiming worktrees.

## 1. The constraint everything else follows from

**The endpoint is remote code execution, by design.** Not incidentally, not if it has a
bug — that is its purpose:

- `fleet_spawn` runs shell commands and creates checkouts.
- `fleet_send` injects prompts into agents running `--dangerously-skip-permissions`.

Anyone who reaches this service runs code as the user. And the data is not incidental
either: the grid's own `LAST MSG` column renders conversation text, and fleet transcripts
contain `DATABASE_URL` for hosted Neon, Clerk keys, and — for the SuperKey fleet — real
insurance policies belonging to real people.

So the security posture is not "add a login page." It is: **the service is never publicly
routable, and every mutating call is authenticated, confirmed and recorded.** Everything
in §5–§7 follows from that sentence, and a change that weakens it is a redesign, not a
tweak.

Note what is deliberately *not* the mitigation: reducing what the phone can do. Parity is
a requirement (§7), so the capability is fixed and the controls are identity,
confirmation and accountability instead.

## 2. What already exists (and why this is smaller than it looks)

Two thirds of this is built.

**The data.** `fleet-grid.mjs --plain` already computes every field the phone needs:

```
$ node bin/fleet-grid.mjs cf-superkey tmux/cf.tmux.conf --plain
0 need you · 2 working · 4 ready
TAB         CHECKOUT     BRANCH                   AGENT   STATUS   LAST MSG                   IDLE
coi-beside  coi-beside   feat/coi-policy-beside…  claude  working  All three states present…   busy 20s
dupe-source dupe-source  investigate/broker-age…  claude  ready    Done. Draft PR **#1165**…   50m ago
```

And it is fast enough that polling is not a design problem:

```
busiest fleet (superkey, 6 live sessions)   0.39s
all 14 projects                             0.17s   (most are empty and exit immediately)
```

**The actions.** `mcp/fleet-mcp.mjs` is already the complete verb set — list, send, read,
spawn, worktrees, inbox, answer, pause, resume, stop, rename, project_add, projects — and
already `project`-aware, so one client can drive every fleet. Since #38 it validates its
own required arguments and refuses a call rather than shelling out with `"undefined"`,
which is exactly the property you want before putting it behind a network.

**What is missing** is a machine-readable output, a transport, and a client.

## 3. Architecture

```
   phone (PWA, home screen)
        │  HTTPS
        │  over Tailscale — never the public internet (§5)
        ▼
   fleet-serve            ── reads ──►  fleet-grid.mjs --json
   (node, on the Mac)     ── acts ──►   MCP dispatch (same handlers, same guards)
                          ── holds ──►  caffeinate (§8)
```

One new daemon, one new flag, one static client. No new logic: `fleet-serve` is a
transport over code that already exists, and that is deliberate — a second implementation
of "what is this session doing" would drift from the grid's, and the grid's is the one
with the scars.

## 4. `fleet-grid.mjs --json`

`--plain` is formatted for a TTY: branches elide to `feat/coi-policy-beside-fo…` and at
narrow widths columns collide (`people-dupespeople-dupes`). The *values* are already
computed by `cardLines()` — they are truncated on the way out. `--json` emits them whole.

The schema is deliberately **exactly what `cardLines()` consumes**, so the phone renders
from the same inputs the TUI does and the two cannot disagree:

```jsonc
{
  "project": "superkey",
  "profile": "work",
  "counts": { "need_you": 0, "working": 2, "ready": 4,
              "parked": 0, "limit": 0, "interrupted": 0 },
  "cards": [
    {
      "name":      "coi-beside",          // what fleet-send/fleet-read address
      "label":     null,                  // titles the card when set; name moves to line 2
      "status":    "working",             // the nine-value vocabulary, verbatim
      "folder":    "coi-beside",          // the worktree it sits in
      "branch":    "feat/coi-policy-beside-form",
      "agent":     "claude",              // rendered only when != claude
      "msg":       "All three states present. Running the full suite…",
      "age":       20,                    // seconds; null when unknown
      "attached":  false,
      "sched":     null,                  // { "at": <epoch> } → card shows @HH:MM
      "limit_at":  null                   // "10:20pm" → card shows ↻ 10:20pm
    }
  ],
  "free_worktrees": [
    { "path": "/Users/…/api-3", "branch": "feat/x", "task": "…" }
  ]
}
```

Three rules this schema has to keep, each of which the TUI already keeps and each of
which is a way the summary could lie:

1. **`status` carries all nine values** — `need-you`, `working`, `ready`, `parked`,
   `idle`, `starting`, `unknown`, `limit`, `interrupted`. Do not collapse them client-side.
2. **`unknown` is not `idle`.** It means the agent's adapter has no validated busy
   detector and we genuinely cannot tell. Rendering a confident green dot it has not
   earned is the exact failure the status layer exists to prevent.
3. **`limit` is never folded into `ready`.** Five workers at a usage ceiling rendered as
   "5 ready" is the summary line lying at a glance, which is the one place it must not.

`--json` is additive. `--plain` and the TUI are untouched.

## 5. Transport: reachable from anywhere, routable from nowhere

These are separable properties and the design depends on separating them.

**Recommended: Tailscale.** A WireGuard mesh — it works from cellular, a hotel, anywhere,
while the Mac has **zero inbound open ports**. Device-level keys, MFA through the identity
provider, MagicDNS for a stable name, and a lost phone is revoked from the admin console
in seconds. It fails *closed*: a misconfiguration makes the service unreachable, not
public.

**Explicitly not Tailscale Funnel.** That is the feature that publishes to the internet.

**Acceptable alternative: Cloudflare Tunnel + Cloudflare Access.** `cloudflared` is
already installed on this machine (the SuperKey dev-stack skill uses it). Outbound-only,
no open ports, and Access adds SSO, policy and audit logs. Choose it if a real URL is
wanted. The tradeoff is honest: the hostname *is* publicly routable and all the security
lives in the Access policy being right, so it fails *open*.

**Rejected: quick tunnels.** `cloudflared tunnel --url` and `ngrok http` — both installed
here — publish to the open internet behind a random hostname. That is security by
obscurity, and scanners enumerate those hostnames. For an endpoint that spawns processes
it is not a tradeoff, it is a breach with a delay.

### Auth on top of the transport

The VPN authenticates a **device**, not a person; an unlocked phone on the tailnet is
inside. So the service also requires:

- a **bearer token**, device-bound and individually revocable, stored in the PWA;
- **bind to the tailnet interface only**, never `0.0.0.0`, so a bug in the VPN layer does
  not immediately mean a bug in this one;
- an **append-only audit log** of every request that changes anything, so "what happened"
  is answerable;
- **rate limiting**, because a token that leaks should be slow to exploit.

Passkeys/WebAuthn are the natural second factor for destructive actions in §7 v3, and
Safari supports them, which is most of what a native Face ID gate would have bought.

## 6. Client: a PWA, and the reason is the repo

The client is a **Progressive Web App**, served by `fleet-serve`, installed to the home
screen. React Native was considered and rejected — the deciding argument is not developer
preference, it is what this repository is:

```
$ cat package.json | grep -c dependencies      0
$ ls node_modules                               (does not exist)
$ grep -ahoE "^import .* from '[^n.]" bin/*.mjs mcp/*.mjs
                                                (no output — node builtins only)
```

ghostfleet is a **zero-dependency npm package** on node ≥18 builtins: 5 shell scripts, 4
`.mjs`, 2 tmux configs. A PWA keeps that — one HTML file and one JS file served by a
process that already exists. React Native brings `node_modules`, a build step, EAS and a
native toolchain into a package whose whole pitch is `npx ghostfleet`.

Two supporting reasons: the UI is a **monospace card grid**, which is native to HTML and
something RN's flexbox would fight to reproduce; and updates are instant, which matters
for a tool that will be iterated on daily. The Apple Developer account is available, so
distribution cost is *not* part of this argument.

**Note on Expo Go**, since it was raised: it is a development sandbox, not a distribution
channel. Shipping installed requires EAS Build plus TestFlight. Running permanently inside
Expo Go against a dev server is possible for personal use but needs Expo Go open and the
dev server up, and cannot do reliable background push — the worst combination for a thing
you glance at from a café.

**If push reliability proves to be the blocker, RN becomes correct and the migration is
cheap**, because the server API does not change. That is a reason to specify §4 well, not
a reason to build RN now.

### The layout is the grid

Not a new design. `renderGrid()` computes its card columns from width — `const nc =
cols()` — so **a phone is `nc = 1`**. The card is the same five lines `cardLines()`
produces:

```
╭─ 1 coi-beside ───────────────╮
│ ◆ working            busy 41s │   status · age (or ↻ reset, or @scheduled)
│ coi-beside · feat/coi-poli…   │   worktree · branch  (+ agent when != claude)
│ "All three states present."   │   last message
╰───────────────────────────────╯
```

The `+ new session` card and the grey `FREE` worktree cards carry over unchanged, because
they are already cards. Screens map one to one: Projects → grid → session. Keys map to
touch: `1-9`/`⏎` → tap, `⇧hjkl` → drag to reorder, `p`/`P` → swipe, `x` → long-press with
the same `y = yes` confirmation.

**The stack has no phone equivalent** and does not need one. It exists to put four
sessions side by side; a phone has no side, and at `nc = 1` that is just the card list.

## 7. Full parity, and where the guardrails actually live

**The phone gets the whole verb set, including `spawn` and `stop --reclaim`.** A
read-only first phase was proposed and rejected: an app that reports a worker has been
blocked on "Allow `pnpm test`?" since 9pm and cannot answer it has not solved the problem
that motivated it, it has only described it more conveniently.

That decision does not lower the bar from §1, it moves where the bar is enforced. If
capability is fixed at parity, security stops being about *restricting what can be done*
and becomes about *proving who is doing it, and leaving a record*:

- **Passkey / WebAuthn re-auth on the destructive verbs** — `spawn`, `stop --reclaim`,
  `rename`, `kill`. Not a block; a biometric prompt at the moment of action, so a phone in
  someone else's hand is not the same as a phone plus its owner. **This makes the phone
  stricter than the terminal**, which cannot ask for a fingerprint.
- **The TUI's own confirmations, reproduced.** The grid already guards these, and
  inheriting them *is* parity rather than an addition:

  ```
  kill session 'coi-beside'?          y = yes · any other key = cancel
  remove worktree 'api-3' (feat/x)?   y = yes · any other key = cancel
                                      f = remove anyway
  ```

  A phone confirmation is a second deliberate tap, and `--force` needs its own.
- **Every mutating call writes an audit row**, and that row surfaces as a `fleet-inbox`
  entry (§12). A log nobody reads is a compliance gesture; a log that appears in the grid
  is a control.
- **Rate limiting**, so a leaked token is slow to use.

Enforcement is **server-side on the tool name**, never on which buttons the client draws.
A client-side restriction is a suggestion.

### The two things that cannot transfer

Physical constraints, not policy:

- **The stack** (§6) — it exists to put sessions side by side, and a phone has no side.
- **`Ctrl-t` terminal and `Ctrl-n` editor tabs** — these open a shell and neovim in the
  session's folder. There is no local shell on the phone to open them in. Streaming a
  remote shell is a much larger surface than the rest of this document combined and is
  deliberately out of scope; the fleet verbs cover what those tabs are usually reached
  for.

Everything else maps: `n` new · `w` worktree · `s` schedule · `p`/`P` pause and resume ·
`x` kill or remove · `,` settings · `⇧hjkl` reorder · `Ctrl-f` jump · `Ctrl-p`/`Q`
projects · `q` back.

## 8. Availability: the measurement that nearly sinks it

```
$ pmset -g custom
Battery Power:   sleep 1    ttyskeepawake 1
AC Power:        sleep 1    ttyskeepawake 1    womp 1
```

**The Mac is configured to sleep after one minute idle — on AC as well as battery.** The
fleet survives today only because `ttyskeepawake` holds the machine awake while tmux ttys
are active. That is incidental, not designed: quiet ttys or closed windows and the machine
sleeps, and the phone sees nothing with no explanation.

Required before any of this is useful:

```
sudo pmset -c sleep 0          # never sleep on AC
```

plus `fleet-serve` holding a `caffeinate` handle for as long as it runs (already a pattern
in this repo, and already guarded as macOS-only). `womp 1` gives Wake-on-LAN, which is
LAN-only and does not help from a café.

## 9. Push, and an honest gap

iOS Web Push works for home-screen-installed PWAs (16.4+), but it is throttled, the
service worker is killed aggressively, and there is no background fetch while closed. For
"a worker finished," polling on open is fine. For "a worker is blocked on you," it is not.

**Mitigation, using something already shipped:** Claude Code has native mobile push —
`/config` → *Push when actions required* — which fires on permission prompts and
questions. Enabling Remote Control on **masters only** delivers the urgent alert natively
from the Claude app while the PWA remains the map.

This is deliberately not "use Remote Control as the UI," which was considered and
rejected: Remote Control addresses one session at a time by name and has no notion of a
fleet, a grid, or a hierarchy — the things this document exists to put on a phone. It is
being used here as a bell, not as a screen.

Worth noting the addressing already lines up: since #35 every fleet session is named
`<project>/<session>`, which is exactly the name Remote Control connects by, so a session
card can deep-link into the Claude app for the conversation surface without ghostfleet
building a chat client.

## 10. What this does not do

- **No redesign of the grid.** The phone renders the existing cards, glyphs and status
  vocabulary. Two divergent layouts would have to be kept in step forever.
- **No stack view** (§6).
- **No chat client.** A session's conversation is Remote Control's job (§9).
- **No second status implementation.** Everything comes from `fleet-grid.mjs` (§3).

## 11. Decisions

**Settled:**

1. **Transport: Tailscale** (§5). It fails closed, and this endpoint is RCE. Funnel stays
   off — that is the single setting that would undo §5, and it should be asserted, not
   remembered.
2. **Full parity, not a read-only phase** (§7). An app that can see a blocked worker but
   not unblock it describes the problem instead of solving it. The guardrails move to
   identity, confirmation and audit rather than reduced capability.

**Still open:**

3. **Redaction scope**, and parity raises the stakes rather than lowering them: reading a
   session is part of parity, so the scrollback now crosses the wire, where the earlier
   read-only sketch would have served one sentence per card. Transcripts contain a hosted
   `DATABASE_URL`, Clerk keys, and SuperKey's real policy data. Options: (a) a
   secret-pattern filter on the way out, (b) serve a bounded tail rather than full
   history, (c) both. Recommendation: **both** — (a) because the values are known shapes
   and cheap to match, (b) because a bound limits the blast radius of whatever (a) misses.
4. **Multi-user?** Assumed single-user throughout. Anything else changes the auth model
   from "a token" to "identities and per-project authorization."

## 12. Open risks

- **Parity means the phone can delete work.** `stop --reclaim` removes a worktree, and
  `fleet-clean`'s gates are about whether removal is *safe*, not whether it was
  *intended*. The passkey and the reproduced confirmation (§7) are what stand between a
  pocket and a deleted checkout, so they are load-bearing, not decoration.
- **Redaction is a filter, and filters miss.** Every line of transcript crossing the wire
  is potential exfiltration of production secrets — now more of it, per decision 3.
- **A phone is lost more often than a laptop.** Revocation has to be one action and it has
  to be testable; "the token is in the PWA" is only safe if killing it is trivial.
- **The audit log is only useful if something reads it.** An unread log is a compliance
  gesture. It should surface in the grid — a `fleet-inbox` row when a mobile action fires
  is the natural place, and costs almost nothing.
