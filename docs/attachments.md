# Attachments: can we send pictures?

**Status: BUILT.** A camera sits beside the composer, the photo goes up as-is, the Mac
converts it, and the path lands in the box where you can see it before you send. What
follows is the research that decided the shape; two of its recommendations were overturned
on the way and both are marked in place rather than edited away.

> **What was built differently, and why.** §3-§4 planned to downscale on the PHONE
> (`createImageBitmap` → canvas → `toBlob`) and keep the 1 MB body cap. Every measurement
> behind that was taken in Chrome on macOS, and the device this feature exists for hands out
> **HEIC** — whether Safari's `createImageBitmap` decodes a HEIC Blob is *still* unmeasured
> (`scripts/heic-probe.mjs` remains unrun). So the original bytes go up and `/usr/bin/sips`
> converts them here, which makes the answer irrelevant instead of load-bearing. The cost is
> the body: that ONE route accepts 9 MB where every other still accepts 1, and a photo over
> 6 MB is refused with a message that says 6 MB.
>   §5 argued for a *verb* rather than an endpoint, so it would inherit the Origin check,
> the session gate, the rate class and the audit chain. It is a **route** — because all of
> that machinery turned out to be central and keyed on nothing: it runs above the router, so
> a new POST path gets every bit of it by existing. What a verb could *not* have is its own
> body cap, since the body is read once before dispatch and the tool name is inside it. The
> thing §5 was protecting is kept; the one thing it could not give is gained.
>   Everything else was built as written: bytes under the fleet dir keyed `<sock>.<session>`,
> filenames generated here and never the client's, content sniffed and SVG refused by name,
> no route that serves the bytes back, a per-session quota, and the path put in the composer
> rather than sent invisibly.

**Status of the research below: as measured on 2026-08-24.** The question is whether you can attach a photo on the
phone and have it reach the agent in a session. The answer is **yes for `claude`, yes for
`codex`, and model-dependent for `opencode`**.

> **Corrected 2026-08-24.** The first version of this document said codex could not, on the
> strength of an `Unable to inspect image` and a timing-out tool router. That was wrong, and
> it was wrong in the way this repo distrusts most: an *inference* presented next to
> measurements. The cause was macOS Gatekeeper holding codex's helper binary at a
> first-launch quarantine dialog. With the dialog cleared, codex reads images from a path
> and gets them right (§2). The correction is kept visible rather than edited away, because
> the failure mode it introduces is real and is now §2a.

**Recommendation: build it, narrowly.** Narrowly means one new *verb* rather than a new
endpoint, ~1600px JPEG produced on the phone, bytes under the fleet dir, and a composer that
warns when the worker it is aimed at may not be able to see images. Built that way it is
small, because the size problem solves itself and the security machinery already exists.
The honesty burden is smaller than it first looked — two of three agents work — but it has
not gone away, because the third cannot be identified in advance
([docs/multi-agent-sessions.md](multi-agent-sessions.md)).

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

**These are measurements of specific builds on a specific day, not properties of the
agents.** All of it on this Mac, **2026-08-24** (the codex re-run at ~21:40 EDT):

| agent | build | model it actually ran |
| --- | --- | --- |
| `claude` | Claude Code **2.1.243** | Haiku 4.5 |
| `codex` | `codex-cli` **0.147.0** | `gpt-5.6-terra` |
| `opencode` | **1.18.21** | `opencode/big-pickle` (asked it directly) |

Any of those moving can move the answer — and one of them did, twice, inside this
document's own lifetime: codex's row flipped from "no" to "yes" without codex changing at
all (§2a), and the whole point of §2's last paragraph is that opencode's row is a property
of a *model id* that a user can change with one config edit. **Re-run the probe rather than
trusting this table.** The images that produce it are twenty lines of `zlib` and no
dependencies; the prompt is one sentence.

| agent | image from a path in the prompt | notes |
| --- | --- | --- |
| `claude` | **yes** — `Read 1 file`, correct text and colour | verified end-to-end through `fleet-send` |
| `codex` | **yes** — after clearing a Gatekeeper prompt (§2a) | reproduced three times |
| `opencode` | **no, on the model configured here** | and it says so out loud, unprompted |

The first two probes used a nonsense token drawn in a homemade 5×7 bitmap font, which turns
out to be genuinely hard to OCR and made the results harder to read than they needed to be.
The confirming probe drops text entirely: **N solid orange squares on dark green**. Counting
them needs vision and not OCR, and the answer is unguessable from a file called `photo.png`.

```
$ codex exec "Look at ./photo.png . Reply with ONLY: how many squares, what colour the
              squares are, what colour the background is."
6 squares, orange, dark green          # the file had 6.  Reproduced with 3: "3 orange
                                       # squares, dark green background"
```

Three codex runs, all correct on colour, two exactly correct on count. **codex reads an
image from a path in the prompt text**, which is the channel the fleet actually has.

codex also has an explicit `-i, --image <FILE>...` flag for attaching images to an initial
prompt, and it works — but it is unreachable from here, because the fleet pastes into an
already-running pane and a flag can only be passed at launch. It does not matter: the path
in prompt text works, which is the thing the fleet can actually do.

**opencode refuses honestly, and that reply IS the measurement** — not a summary of one.
It is what `opencode 1.18.21` running `opencode/big-pickle` printed on 2026-08-24, twice,
to two different probes. Verbatim, first to the token probe:

> I can't read the image — this model doesn't support image input, so the photo.png failed
> to load and I can't extract the text or background colour from it.
> You could try running OCR locally instead, e.g. `tesseract photo.png stdout`.

and again to the OCR-free shapes probe, which rules out "it saw the image and could not read
the font":

> I can't read the image — this model doesn't support image input, so I can't count the
> squares or identify colours in photo.png.

Both runs show `→ Read photo.png` in the transcript first. So the *tool* fired and the
**model** rejected the image — which is a different fact from "opencode cannot show an agent
an image", and the difference is the whole of §2's point. opencode routes to whatever
model is configured — `opencode/big-pickle` here, which it will tell you if you ask it. A
vision-capable model under opencode would presumably work; that was not tested, because
changing the owner's model configuration to find out is not mine to do.
**So "opencode cannot see images" is not a fact ghostfleet can assert.** It
is a property of a session's configured model, which the fleet does not know and cannot
cheaply discover. Any static per-agent capability table in the client would itself be the
dishonest thing.

That gives the honesty rule its shape:

- **`claude`** — attach freely.
- **`codex`** — attach freely too, now that this is measured rather than inferred. Worth a
  note in the docs about §2a's first-run Gatekeeper step, but not a reason for the composer
  to refuse.
- **`opencode`** — the composer must *warn*, not refuse: "this worker may not be able to see
  images; it depends on its model." Refusing would be wrong, and claiming it works would be
  wrong.

That is a materially smaller honesty burden than the first version of this document
described, and it is worth being precise about *why* it shrank: nothing about the design
changed, an inference was replaced by a measurement and the inference had been wrong.

## 2a. The failure that made codex look incapable, and why it will happen again

The first probe produced this, twice:

```
codex
I'll inspect the image directly.
ERROR codex_core::tools::router: error=timed out negotiating with the code-mode host
ERROR codex_core::tools::router: error=timed out negotiating with the code-mode host
codex
Unable to inspect image.
```

The cause was **macOS Gatekeeper**. Reading an image makes codex launch a helper —
`/opt/homebrew/Caskroom/codex/0.147.0/bin/codex-code-mode-host` — and on its first ever run
macOS held it at the quarantine dialog. codex did not report that; it reported a tool-router
timeout and then a plausible, entirely wrong conclusion about its own capability. Clearing
the dialog changed the answer with no other change.

Two things worth keeping from that:

- **The quarantine attribute survives approval.** `xattr -l` still shows
  `com.apple.quarantine` on the binary that now works, so you cannot test for this by the
  attribute's absence. The only reliable signal is the behaviour.
- **A fleet worker cannot clear that dialog.** It is a system-modal prompt on the Mac's
  GUI. A codex worker in a detached tmux pane has nobody to click it, and someone driving
  that worker from the phone cannot reach it at all — they would see a worker that says
  "Unable to inspect image" and no way to act on it. *(That last step is reasoning, not
  measurement: I did not re-quarantine the owner's binary to prove it, and would not.)*

  So the first image sent to a codex worker on a fresh machine is expected to fail this
  way. The mitigation is a one-time `codex exec -i <any image> "describe this"` run at the
  Mac, before relying on it — the same class of one-time local step as `./install.sh`.

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

Aimed at an `opencode` worker it should warn (§2); aimed at `claude` or `codex` it needs no
special case. That is one warning string, not a capability matrix — and it is the whole of
the honesty requirement now that codex is measured rather than inferred.

**The TUI does not want this and should not get it.** On the Mac the file is already on the
filesystem: you type or paste its path, which is what the measured mechanism in §1 needs
anyway. The only thing a TUI could add is drag-and-drop, which does not work through a
terminal and a tmux pane in any way worth the effort. This is phone-only because the phone
is the only place where the bytes are not already reachable.

## 9. What this does not do

- **It does not promise images work for `opencode` workers.** That depends on a model
  ghostfleet does not know about (§2).
- **It does not clear codex's first-run Gatekeeper prompt for you** (§2a), and nothing
  reachable from the phone can.
- **It does not send the image to the agent.** It puts a file on the disk and puts its path
  in a prompt. The agent decides to read it. If the agent does not, nothing here notices —
  and per §2 that remains possible for an `opencode` worker, which is why the composer warns
  up front rather than reporting afterwards.
- **It does not preserve the original.** The phone re-encodes to JPEG at ~1600px. A photo of
  a whiteboard survives that; a screenshot with 8px text may not. If someone needs a
  full-resolution artefact on the Mac, this is the wrong tool and AirDrop is the right one.
- **It does not give the agent a picture in its context window directly.** It gives it a
  path. The agent spends a tool call and its own tokens reading it.
- **It does not handle video, PDFs, or multiple files.** One image, one path.
- **It does not survive `fleet-clean`.** Attachments are disposable by design; anything worth
  keeping should be committed by the worker.

## 10. The one unknown that gates this, and the five-minute test for it

**Everything about iOS is still unmeasured.** Every number above came from Chrome 151 on
macOS, and the two that the design leans on hardest — §3's sizes and §4's "only
`createImageBitmap` survives the CSP" — were measured in the wrong browser on the wrong
device. Three questions, one of which blocks everything:

- **Does `createImageBitmap` accept a HEIC Blob in iOS Safari?** Safari has the system HEIC
  codec, so it very likely does — and if it does, the downscale step *is* the HEIC
  conversion step, because the canvas re-encodes to JPEG regardless of what went in, so no
  HEIC library is needed anywhere. But "very likely" is not a measurement, and a **no** here
  invalidates §3 and §5 rather than adjusting them.
- **What iOS actually hands to `<input type="file" accept="image/*">`** — HEIC, or a JPEG it
  transcoded on the way out. Behaviour varies by iOS version and by camera-vs-library. It
  does not change the design (the canvas re-encodes either way) but it changes what the
  error path has to say.
- **Whether the downscale feels instant** on a phone rather than a laptop.

The probe answers all three in one tap.

**The probe is written and committed: `scripts/heic-probe.mjs`.** Five minutes, no build
step, nothing stored:

```bash
node scripts/heic-probe.mjs $(tailscale ip -4)
```

Open the printed URL on the iPhone, tap **Pick a photo**, choose a recent **camera** photo
(not a screenshot — screenshots are already PNG and would answer the wrong question). The
result prints in the terminal you started it from.

It binds the tailnet address for the same reason `fleet-serve` does — the phone has to
reach it — and it serves its page under the **identical CSP**
(`default-src 'self'; …`), because a probe served without that header answers a question
nobody asked: §4 measured that the policy blocks `blob:` and `data:` in an `<img>` and
forbids inline script, so the probe keeps its JS in a separate same-origin file exactly as
the real client does. It has no upload endpoint and writes nothing; the photo never leaves
the phone, and the only POST carries a few lines of text back so you are not transcribing
from a phone screen.

What it reports, and what each answer means:

| what you see | what it means |
| --- | --- |
| `createImageBitmap: OK 4032x3024` | **The design in §3–§5 holds.** Safari decodes it, the canvas re-encodes to JPEG, and the HEIC question is answered by the same step that does the downscale — no HEIC library, no new dependency. Proceed. |
| `createImageBitmap: FAILED — …` | **The blocking answer.** The client-side path needs rethinking before any server work: either a HEIC decoder shipped to the phone (large, and a new dependency on a zero-dependency client), or upload-the-original and convert on the Mac (which breaks §3's whole size argument and puts a decoder on the server instead). Stop and redesign. |
| `file: type=image/jpeg` | iOS transcoded on the way out of the picker. Nothing changes; the canvas re-encode is a no-op conversion. Worth knowing for what the error path says. |
| `file: type=image/heic` | iOS handed over the original. Also fine *if* the row above says OK — that is precisely the case being tested. |
| `1600px … FITS the 1 MB cap` | §3's numbers hold on a real photo rather than my synthetic one. |
| `1600px … OVER the 1 MB cap` | A real photo compresses worse than expected. Drop to 1280px (§3 measured 0.55 MB base64 there) — the design survives, the constant changes. |
| `blob: URL -> <img>: BLOCKED` | §4's CSP measurement holds on Safari too, so the preview must be a `<canvas>`. |
| `blob: URL -> <img>: LOADED` | Safari is more permissive here than Chrome. Do **not** rely on it — the canvas preview costs nothing and works on both. |

### What the probe proves, and what it does not

**How long:** about five minutes, nearly all of it walking to the phone. One `node` command,
one URL, one tap, one photo. No build step, no install, no dependency; it is a single file
using only `node:http`. Ctrl-C when the answer prints.

**What it proves.** Exactly four things, all on the device and browser that will actually run
the client:

1. whether iOS Safari's `createImageBitmap` decodes what the picker hands over — the gating
   question, and the only one here that can invalidate the design rather than adjust it;
2. what the picker hands over (HEIC or an iOS-transcoded JPEG), and how big it is;
3. what §3's downscale actually produces from a **real** photo, against the 1 MB cap — my
   numbers came from a synthetic image deliberately made harder to compress than a photo;
4. whether §4's CSP result (`blob:` in an `<img>` is blocked) holds on Safari as well as
   Chrome.

**What it does not prove.**

- **It does not test the feature**, because there is no feature. Nothing is uploaded, nothing
  is written, no endpoint is exercised. The photo never leaves the phone; the only thing sent
  to the Mac is a few lines of text so you are not transcribing from a phone screen.
- **It says nothing about the server side** — §5's verb, §6's storage, §7's sniffing and
  quota are all untouched by it. A green probe means the *client* half is viable, not that
  the design is safe.
- **It is one phone, one iOS version, one photo.** It cannot tell you that every iPhone
  behaves this way, and a screenshot instead of a camera photo would answer the wrong
  question entirely (screenshots are already PNG, so the HEIC path is never taken — hence
  the instruction to pick a camera photo).
- **It does not tell you whether any of this is worth having.** That is §11 and a week of
  real use, not a probe.

Run it **before** any of §5–§7 is built: a "no" on the first row changes the shape of
everything downstream, and it is by a wide margin the cheapest question here to answer.

**The codex re-run is done** and the result changed — see §2 and §2a. What was inference is
now three measured runs.

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

**The honesty burden is real but small.** Two of three agents read images from a path;
`opencode` depends on a model ghostfleet cannot see. So the composer needs one warning, not
a capability matrix — and that warning has to be in the first version, because a silent
no-op for a worker that cannot see the photo is the specific thing this repo keeps having to
go back and fix.

The order that makes sense, unchanged by the codex correction: **run
`scripts/heic-probe.mjs` on the phone first** (§10) — it is five minutes and a "no" there
reshapes everything downstream — then the verb and the sniffer, then the composer with the
`opencode` warning built in from the first commit rather than added after someone notices.

One more thing the correction is worth on its own: an agent reporting its own incapacity is
not evidence of incapacity. codex said `Unable to inspect image` and meant "a helper I
needed did not start". Believing it cost this document a wrong headline, and the same
mistake is available to anyone reading a worker's output on the phone.
