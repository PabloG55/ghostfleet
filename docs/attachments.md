# Attachments: can we send pictures?

**Status: research, nothing built.** The question is whether you can attach a photo on the
phone and have it reach the agent in a session. The answer is **yes for `claude` workers,
no for `codex`, and unknowable-in-advance for `opencode`** — and that split is the whole
design problem, because a feature that silently does nothing for two of three agents is
exactly the dishonest degradation [docs/multi-agent-sessions.md](multi-agent-sessions.md)
forbids.

**Recommendation: build it, narrowly, or not at all.** Narrowly means one new *verb* rather
than a new endpoint, ~1600px JPEG produced on the phone, bytes under the fleet dir, and a
composer that says out loud when the worker it is aimed at cannot see images. Built that
way it is small, because the size problem solves itself and the security machinery already
exists. Built as a generic "attachments" feature it is a trap: it becomes the first
endpoint that writes externally-supplied bytes to disk, and it lies to two thirds of the
fleet.

Everything below was measured on this machine before any of it was argued. Where something
could not be measured — every claim about iOS — it says so and says what it would take.

---

## 1. The decisive test: does an agent read an image from a path?

`fleet-send` pastes **text** into a tmux pane. An image cannot be pasted as text, so it has
to become a file on the Mac and the prompt has to name its path. Everything else is
plumbing around that one question, so it was asked first.

A PNG was generated whose content cannot be inferred from its filename or its path: a
nonsense token drawn as pixels on a distinctive purple, in a file called `photo.png`. Then
a real Claude Code session, in a real tmux pane, was given the path through the real
`fleet-send`:

```
❯ Look at the image file /…/work2/photo.png . Reply with ONLY the exact text drawn
  in it and its background colour.
  Read 1 file
⏺ Text: GONDUNO4
  Background colour: Purple
✻ Brewed for 3s
```

`GONDUNO4` is not in the filename, the path, or the prompt. The session called `Read` on
the path and reported what the pixels said. **The mechanism works end to end today**, with
no change to `fleet-send`, `fleet-spawn` or the pane. That is the single most important
result here: the hard part is already done, and what remains is getting bytes onto the disk
safely.

A headless `claude -p` was tried first and agreed (`DUGONGT4`/`Purple` for a different
token — the `7`→`T` is a 5×7 bitmap font's fault, not the model's). The interactive run is
the one that counts, because it is the path the phone would drive.

## 2. Per agent, and why the table cannot be static

Same probe, a fresh unguessable token per agent so no answer could leak between them.

| agent | image from a path in the prompt | notes |
| --- | --- | --- |
| `claude` | **yes** — `Read 1 file`, correct text and colour | verified end-to-end through `fleet-send` |
| `codex` | **no** — "Unable to inspect image" | but see below: it *can* see images, just not this way |
| `opencode` | **no, on the model configured here** | and it says so out loud, unprompted |

**codex is the interesting one.** It has an explicit flag:

```
-i, --image <FILE>...    Optional image(s) to attach to the initial prompt
```

and with `-i` it answered `MUOSON7, purple` — right colour, letters mangled by my 8-pixel
glyphs, but plainly *seeing* the image. Given the same file as a path in the prompt text it
said `Unable to inspect image` after its tool router timed out. So codex's limitation is
not vision, it is **delivery**: the image has to be attached at launch, and the fleet's
channel is a paste into an already-running pane, which can never carry a `-i`. A
`fleet-spawn --prompt` could in principle pass one; a photo sent to a live worker cannot.

*Honest caveat:* `error=timed out negotiating with the code-mode host` appeared in both
codex runs, so something in this environment is degraded. The `-i` run succeeded anyway,
which is why I read the path failure as "the tool it wanted was unavailable" rather than
"codex cannot do this" — but that is inference, and it should be re-run on a healthy codex
before anyone relies on it.

**opencode refuses honestly, and that is the useful part.** It ran the Read and then said:

> I can't read the image — this model doesn't support image input, so the photo.png failed
> to load and I can't extract the text or background colour from it.
> You could try running OCR locally instead, e.g. `tesseract photo.png stdout`.

Note *why*: the tool fired, the **model** rejected the image. opencode routes to whatever
model is configured (`build · big-pickle` here). A vision-capable model under opencode would
presumably work. **So "opencode cannot see images" is not a fact ghostfleet can assert.** It
is a property of a session's configured model, which the fleet does not know and cannot
cheaply discover. Any static per-agent capability table in the client would itself be the
dishonest thing.

That gives the honesty rule its shape:

- **`claude`** — attach freely.
- **`codex`** — the composer must refuse, and say the worker cannot receive images through
  this channel. Sending a path that gets ignored is the failure mode the repo has spent
  three PRs eliminating elsewhere.
- **`opencode`** — the composer must *warn*, not refuse: "this worker may not be able to see
  images; it depends on its model." Refusing would be wrong, and claiming it works would be
  wrong.

## 3. Size: the phone downscales, and the 1 MB cap stops being a problem

`bin/fleet-serve.mjs`'s `readBody` caps a POST at 1 MB and `JSON.parse`s it. A 12MP phone
photo is 2–5 MB and would fail before anything else was considered — which reads like "the
cap must go up". It must not. Measured in Chrome 151 under the production CSP, from a
synthetic 3024×4032 source (a 1.77 MB JPEG, *noisier* than a real photo, so these numbers
are pessimistic):

| downscale | JPEG q0.8 | as base64 in JSON | fits the 1 MB cap |
| --- | --- | --- | --- |
| 2048 wide | 750 KB | 0.95 MB | barely — no headroom |
| **1600 wide** | **560 KB** | **0.71 MB** | **yes, ~30% spare** |
| 1280 wide | 429 KB | 0.55 MB | comfortably |
| 1024 wide | 327 KB | 0.42 MB | comfortably |

**~1600px wide is plenty for an agent and lands well inside the existing cap even after
base64's 33%.** So the cheapest honest design does not touch `readBody`, does not add
multipart, and does not raise a limit. The cap stays exactly where it is and becomes a free
server-side size control — which matters in §5, because it is enforced *before* the body is
parsed or anything is written.

## 4. The CSP already forbids the obvious way to do this

The client is served under:

```
default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

There is no `img-src`, so images fall back to `default-src 'self'`. Measured, by serving a
probe page under that exact header:

```
external script RAN (inline would not: default-src self forbids it)
same-origin fetch allowed (connect-src falls back to default-src self)
source blob 1771176B image/jpeg 3024x4032
A  blob: URL -> <img>   BLOCKED by CSP
B  data: URL -> <img>   BLOCKED by CSP
C  createImageBitmap(Blob) OK 3024x4032  (no URL, no fetch, no CSP involvement)
   downscale 1600x2133 q0.8 -> 559920 B
```

Three things fall out of that, and two of them would have cost an afternoon to discover
during implementation:

- **The textbook downscale recipe does not work here.** `URL.createObjectURL(file)` into an
  `<img>` is how everyone downscales an image in a browser, and `blob:` is not `'self'`, so
  it is blocked. So is `data:`.
- **`createImageBitmap(Blob)` works and needs no CSP change**, because it decodes a Blob
  already in memory: there is no URL and no fetch, so no fetch directive applies.
  `drawImage` and `toBlob` are likewise not fetches. The whole downscale path is available
  under the policy as written.
- **A thumbnail preview in the composer is the part that would need a CSP change** — or
  rather, would need to avoid one by painting the preview into a `<canvas>` element instead
  of an `<img>`. Adding `img-src 'self' blob:` is the alternative and I would not: the
  canvas is already there, and loosening a policy on a page that can spawn processes to
  save one element is a bad trade.

(My first two probe attempts produced nothing at all because the probe used an inline
`<script>`, which this CSP correctly refuses. The real client already loads
`<script type="module" src="./app.js">`, so it is unaffected — but it is a neat
demonstration that the policy is doing its job.)

## 5. The shape: a verb, not an endpoint

`fleet-serve.mjs` has exactly **one** mutating route, `POST /api/verb`, and it dispatches
through an allowlist (`TOOLS_ALLOWED`) of named tools with declared string fields. Every
one of them maps to a `fleet-*` command. **Nothing in the server writes bytes to disk
today, and nothing accepts a non-JSON body.**

That is the reason to make attachments a *verb* rather than a new `POST /api/upload`. A new
verb inherits, for free and without re-litigating any of it:

- the `Origin` check on POST and the `Host` allowlist (DNS rebinding)
- the passkey session gate — no live session, no request
- the write rate-limit class and `serialize()`
- the audit chain and the `MOBILE` inbox row that every mutation already produces
- **the 1 MB body cap, enforced before parsing** (§3)

A separate endpoint would need all of that re-established, and the one that got forgotten
would be the one that mattered.

The decomposition I would argue for is two steps rather than one:

1. `fleet_attach { project, session, data }` — validates, writes the file, **returns the
   absolute path**. Writes nothing into any session.
2. the client then sends a perfectly ordinary `fleet_send` whose prompt contains that path.

This is better than folding bytes into `fleet_send` because it makes "did the file land?"
answerable *before* a prompt is dispatched, and because it leaves `fleet-send` — the most
load-bearing and most-scarred path in the repo — completely untouched.

## 6. Where the bytes live, and who deletes them

**Not the worktree**, and this is measured rather than aesthetic. `git status --porcelain`
reports an untracked file:

```
?? photo.jpg
```

and three separate consumers treat that as dirty:

- `bin/fleet-clean:117` — `keep <wt> — uncommitted changes`, so the worktree is never
  reclaimed
- `bin/fleet-worktrees:76` — the worktree is listed `dirty`
- `bin/fleet-spawn:292` — `dirty -> not free`, so it is never offered for reuse

One photo would permanently remove a worktree from both the reuse pool and the cleanup
sweep. That is a worse outcome than the disk it saves, and it would look like a bug in
`fleet-clean`.

**Not a bare temp dir** either: nothing in the fleet reaps per-session temp directories when
a session dies, so it would grow without an owner.

**Under the fleet dir**, keyed the way everything else there is keyed:

```
$CLAUDE_FLEET_DIR/attach/<sock>.<session>/<random>.jpg
```

That directory already holds per-session state under exactly this `<sock>.<session>`
convention (status JSON, `.parked`, `.sched`, `.agent`, the manifest), it is already 9.3 MB
of small files, and it already **has a cleanup owner**: `fleet-clean` sweeps "stale fleet
state — dead `*.governor.pid`, orphan `*.parked` / `*.sched` markers". An attachment
directory whose session no longer exists is precisely another orphan class, so cleanup is an
addition to something that exists rather than a new mechanism nobody remembers to run.

That leaves the case `fleet-clean` cannot help with: a session that lives for weeks and gets
a photo a day. So a **per-session quota** — a small number of megabytes, oldest deleted
first — enforced in the verb itself, not left to the sweeper. A quota is also the only
defence against §7's disk-exhaustion case that works while the fleet is running.

## 7. Security, which is the main event

This would be the **first endpoint in ghostfleet that writes externally-supplied bytes to
disk**. Everything the server does today is "run a named command with validated string
arguments". That is a genuinely new class of surface, and most of the work is here rather
than in the feature.

**Filenames are never the client's.** The server generates the name from a random id plus an
extension derived from what it *sniffed*, never from anything the client sent. No client
string ever becomes a path component — not the filename, not the extension, not the session
name without its own validation. This kills path traversal by construction rather than by
sanitising, because sanitising is a list of things you remembered.

**Sniff the content; do not trust the declared type.** Accept only what the magic bytes say
is JPEG (`FF D8 FF`) or PNG (`89 50 4E 47`). Refuse everything else, and refuse **SVG**
loudly and specifically: an SVG is an image that is also a script container, and the moment
one is stored under a name ending `.svg` somebody eventually serves it back.

**Never serve the bytes back.** There should be no `GET /api/attachment/<id>`. The composer
that just uploaded the photo already has the local Blob and never needs the server's copy.
Not building a read path removes stored XSS, content-type confusion on the way out, and an
unauthenticated read of the user's photos, all at once — and it costs nothing, because
nobody wants that route.

**Size is enforced server-side regardless of what the phone did.** §3's design gets this for
free: the 1 MB cap in `readBody` fires before the JSON is parsed. The verb should *also*
check the decoded byte length, because base64 that decodes to something implausible is a
signal in itself.

**The rate-limit class is wrong for this verb as it stands.** `write` is 30/minute. Thirty
photos a minute at 750 KB is 22 MB/min — over a gigabyte an hour — and unlike every other
write verb, this one costs disk that is never reclaimed until a sweep. The existing class is
calibrated for "paste text into a pane". Attachments want a tighter class of their own, and
the per-session quota from §6 as the real backstop.

**The passkey gate is the right bar for *who*, and does nothing about *how much*.** I would
*not* require a fresh per-photo assertion the way `fleet_spawn` and `fleet_stop` do: those
are destructive and rare, this is neither, and a passkey prompt per photo is the kind of
friction that gets a feature turned off. The live-session gate plus the tighter rate class
plus the quota is the right combination. Say that out loud rather than implying the passkey
covers it.

**An image is untrusted input to an agent that can run commands.** The worker runs with
`--dangerously-skip-permissions`. A photo containing text that reads like instructions is a
prompt-injection vector, and the agent will read that text because reading it is the entire
point. The threat model here is narrow — the uploader is the enrolled owner of an enrolled
device — so this is not a reason to refuse the feature. It *is* a reason to write it down,
because "the photo is just data" is exactly the assumption that makes it dangerous later,
and because it argues against ever letting an attachment come from anywhere but the enrolled
client.

**Mechanical hygiene:** create the directory with restrictive permissions, write with
`O_EXCL` to a fresh random name, never follow a symlink, never write through a path that
existed before this request.

### What I would refuse to build

- A route that serves uploaded bytes back to a browser.
- Any client-controlled path component — filename, extension or directory.
- SVG support, or anything not positively sniffed as JPEG or PNG.
- A raised body cap or a multipart parser. The phone can downscale (§3); the cap is a
  load-bearing control that also happens to be free.
- Storage inside a worktree (§6).
- An unauthenticated or "just this once" variant for convenience.

## 8. The composer, and why the TUI does not want this

On the phone: a camera/library control next to the mic, `<input type="file" accept="image/*">`.
Pick → `createImageBitmap` → canvas → `toBlob('image/jpeg', 0.8)` at 1600px → `fleet_attach`
→ the returned path is **appended to the composer text where the user can see it**, so what
gets sent is never a mystery. Preview painted into a `<canvas>`, not an `<img>` (§4).

Aimed at a `codex` worker the control should be disabled with a reason; aimed at `opencode`
it should warn (§2).

**The TUI does not want this and should not get it.** On the Mac the file is already on the
filesystem: you type or paste its path, which is what the measured mechanism in §1 needs
anyway. The only thing a TUI could add is drag-and-drop, which does not work through a
terminal and a tmux pane in any way worth the effort. This is phone-only because the phone
is the only place where the bytes are not already reachable.

## 9. What this does not do

- **It does not make images work for `codex` workers.** The channel cannot carry them (§2).
- **It does not promise images work for `opencode` workers.** That depends on a model
  ghostfleet does not know about.
- **It does not send the image to the agent.** It puts a file on the disk and puts its path
  in a prompt. The agent decides to read it. If the agent does not, nothing here notices —
  and per §2 that is a real possibility for two of three agents, which is why the composer
  has to be honest up front rather than reporting afterwards.
- **It does not preserve the original.** The phone re-encodes to JPEG at ~1600px. A photo of
  a whiteboard survives that; a screenshot with 8px text may not. If someone needs a
  full-resolution artefact on the Mac, this is the wrong tool and AirDrop is the right one.
- **It does not give the agent a picture in its context window directly.** It gives it a
  path. The agent spends a tool call and its own tokens reading it.
- **It does not handle video, PDFs, or multiple files.** One image, one path.
- **It does not survive `fleet-clean`.** Attachments are disposable by design; anything worth
  keeping should be committed by the worker.

## 10. What I could not settle

**Everything about iOS.** There is no iPhone in this loop, and every number above came from
Chrome 151 on macOS. Specifically unverified:

- **Does `createImageBitmap` accept a HEIC Blob in iOS Safari?** Safari has the system HEIC
  codec, so it very likely does — and if it does, the downscale step *is* the HEIC
  conversion step, because the canvas re-encodes to JPEG regardless of what went in. No HEIC
  library needed. But "very likely" is not a measurement, and this is the one thing that
  must be checked on a real device before anyone commits to the design, because if it throws
  the whole client-side path needs rethinking.
- **What iOS actually hands to `<input type="file" accept="image/*">`** — HEIC, or a JPEG
  that iOS transcoded on the way out. Reported behaviour varies by iOS version and by
  whether the source is the camera or the library. It does not change the design (the canvas
  re-encodes either way) but it changes what the error path has to say.
- **Whether the downscale is fast enough to feel instant** on a phone rather than a laptop.

**What it would take:** the probe in §4 is about forty lines and already written; serving it
from `fleet-serve` and opening it on the phone would answer all three in one sitting. That
should happen before any of §5–§7 is built, because a "no" on the first question changes the
shape of everything downstream.

**The codex result deserves a re-run** on an environment where its tool router is healthy
(§2).

**Not measured: what a worker actually does with a photo.** Every test here asked "what does
this image show", which proves the mechanism and nothing about whether the feature is
useful. Whether a screenshot of a broken UI actually helps a worker fix it is a question for
a week of real use, not a probe.

## 11. The verdict

**Worth building, narrowly.** The expensive part — getting an image into an agent's
attention from a path — already works and needed no code (§1). The size problem dissolves
into ~20 lines of canvas on the phone and leaves the server's limits alone (§3). The
security machinery that a byte-writing endpoint needs already exists and is inherited by
making it a verb (§5). What is left is a sniffer, a path generator, a quota, and a cleanup
rule — small, and almost all of it §7.

**Not worth building as a generic feature.** Two of three agents cannot use it through this
channel, and one of those two cannot even be *statically identified*. If the per-agent
honesty from §2 is not in the first version, the feature ships a silent no-op for most of the
fleet, and silent no-ops are the specific thing this repo keeps having to go back and fix.

The order that makes sense: verify HEIC on a real phone (§10), then the verb and the
sniffer, then the composer with the per-agent rules built in from the first commit rather
than added after someone notices.
