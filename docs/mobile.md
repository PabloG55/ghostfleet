# Mobile: the fleet from a phone

**Status:** design settled; `--json` (§4) shipped in #41, `fleet-serve` and the client in
flight. Three decisions are settled: the transport is Tailscale with Tailnet Lock (§5),
the phone gets the **full verb set** rather than a read-only phase (§7), and content is
served **unredacted** (§11.3).
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

The schema is deliberately **exactly what `cardLines()` consumes** — with one deliberate
addition, noted under the block — so the phone renders from the same inputs the TUI does
and the two cannot disagree:

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
      "sched":     null,                  // { "at": <epoch>, "msg": "…" } → card shows @HH:MM
      "limit_at":  null                   // "10:20pm" → card shows ↻ 10:20pm
    }
  ],
  "free_worktrees": [
    { "path": "/Users/…/api-3", "branch": "feat/x", "task": "…" }
  ]
}
```

`sched` carries the scheduled **prompt** as well as the time, and that is the one place
this schema is not simply what the card draws. `@10:30pm` with no way to say *what* will
be sent is half a fact: in the TUI you are one keystroke from the session and can go and
look, and on a phone you are not, so the text is the difference between a card that
informs and a card that raises a question it cannot answer. It is emitted **whole** —
a user-authored prompt of arbitrary length, the only such field here — because clipping
it in the emitter would be a display decision taken in the wrong layer, and §11.3 already
settled that content is served unredacted and bounded only for transport cost. The client
clips, exactly as it does for `msg`. The marker on disk also holds the `pid` of the
process that will send it; that is deliberately **not** on the wire, because it names a
process on one machine and means nothing to a client that is not on it.

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

### Who can join the tailnet at all

The ACL question and the enrolment question are different, and only the second one
survives a compromised Tailscale account — an attacker with the account enrols their own
node and never touches the PWA.

**Tailnet Lock** closes that. With it on, a new node needs a cryptographic signature from
one of *your* existing trusted nodes, and peers reject an unsigned key, so **neither a
compromised account nor a compromised Tailscale coordination server can add a device**.
Available on the Personal plan.

It has a real failure mode that has to be handled at setup, not later: enabling it issues
**ten disablement secrets, once**. Lose those *and* the signing nodes and the tailnet
cannot be recovered — not by support, unless a secret was deposited with them in advance.
So designate both the Mac and the phone as signing nodes (two is the minimum anyway) and
store the secrets somewhere that survives losing both devices.

**A tag-based ACL** then narrows what an enrolled device may reach. The default tailnet
policy is `src: * → dst: *:*` — every device reaches every other — so a future work
laptop silently gets the fleet unless this is written:

```json
{ "action": "accept",
  "src": ["tag:fleet-client"],
  "dst": ["tag:fleet-server:8787"] }
```

Tags, not node IDs: a node ID changes on reinstall, and an ACL pinned to a stale one
either breaks confusingly or — if `*` gets pasted in while debugging — widens silently.

### Auth on top of the transport

The VPN authenticates a **device**, not a person; an unlocked phone on the tailnet is
inside. So the service also requires:

- **A passkey at every open.** Face ID on cold start and after the app has been
  backgrounded for a few minutes. Not a password: a password typed twenty times a day
  converges on something short, autofills from a manager on the very unlocked phone that
  is the threat, and is replayable. A passkey is bound to the secure enclave, cannot be
  copied off the device, and does not degrade with use.
- **Server-enforced, not client-enforced.** The passkey assertion mints a short-lived
  session token (~15 min) and the API rejects any request without a live one. A lock
  screen that only gates the UI is decoration — `curl` with the bearer token would walk
  straight past it.
- **A bearer token** identifying the enrolled client, device-bound and individually
  revocable.
- **A second passkey assertion on the destructive verbs** (§7).
- **Bind to the tailnet interface only**, never `0.0.0.0`, so a bug in the VPN layer does
  not immediately become a bug in this one.
- **An append-only audit log** of every request that changes anything, surfaced as a
  `fleet-inbox` row (§12).
- **Rate limiting**, because a token that leaks should be slow to exploit.

The layers answer different questions, which is why all of them are here: Tailnet Lock —
*can this device join*; the ACL — *may it reach this port*; the passkey — *is this the
owner*; the session token — *is that still true right now*.

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

3. **Content is served unredacted.** A secret-pattern filter was proposed and dropped.
   Transcripts do hold live-shaped credentials — measured across the SuperKey transcripts:
   16 `sk_live_`, 139 `sk_test_`, 194 JWTs, 2 AWS key IDs, 51 `CLERK_SECRET`, 4213
   `DATABASE_URL`, in a corpus whose largest single file is 46 MB. But under this
   transport there is no adversary it defends against. The public internet cannot route
   here; a thief past Face ID has the password manager too; and anyone who compromises the
   tailnet has **full parity, which is RCE** — beside that, transcript text is the least
   valuable thing they take. The filter's cost is real and immediate by contrast: masking
   `sk_live_…` corrupts any session that is legitimately *about* key handling.

   **Pagination stays, for performance rather than secrecy.** Shipping 46 MB down a
   WireGuard tunnel on cellular is slow and expensive. Serve a bounded tail — 20 messages,
   matching `fleet-read` — with an explicit "load more". That is pagination, which every
   app has, and it should not be described as a security control.

4. **Multi-user?** Assumed single-user throughout, and §3's reasoning **depends on it**:
   "my phone, my sessions" is what makes unredacted content correct. A second person on
   the tailnet, an org-managed tailnet, or a shared node all reopen §3 and change the auth
   model from "a token" to identities and per-project authorization.

## 12. Open risks

- **Parity means the phone can delete work.** `stop --reclaim` removes a worktree, and
  `fleet-clean`'s gates are about whether removal is *safe*, not whether it was
  *intended*. The passkey and the reproduced confirmation (§7) are what stand between a
  pocket and a deleted checkout, so they are load-bearing, not decoration.
- **Tailnet Lock can lock *you* out.** Ten disablement secrets, issued once. Lose them and
  the signing nodes and the tailnet is unrecoverable. This is the only risk here that is
  permanent, and it is created at setup — so the secrets go somewhere that survives losing
  both devices, before the feature is switched on, not after.
- **Decision 3 rests on decision 4.** Serving unredacted transcripts is correct *because*
  the tailnet is one person's. That premise is stated (§11.4) precisely so that adding a
  second person is recognised as reopening it rather than as an admin chore.
- **A phone is lost more often than a laptop.** Revocation has to be one action and it has
  to be testable; "the token is in the PWA" is only safe if killing it is trivial. The
  passkey (§5) is what stands between a lost-but-unlocked phone and the fleet.
- **The audit log is only useful if something reads it.** An unread log is a compliance
  gesture. It should surface in the grid — a `fleet-inbox` row when a mobile action fires
  is the natural place, and costs almost nothing.
