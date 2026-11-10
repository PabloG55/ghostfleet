# Talk to the linked lead with Siri

Say “Oye Siri, cerebro”, dictate one question, and hear the linked project's
`master` answer. Each invocation is one turn. The Shortcut uses the same HTTPS
address on iPhone, Mac and Apple Watch. AirPods and CarPlay invoke the iPhone's
Shortcut. The paired host's existing `fleet-serve` forwards to `fleet-serve` on
the machine running the Telegram-linked session. No new network listener runs.

## Mint, install, use and revoke

After installing the change, check `fleet-telegram status` on the turn host.
`linked:` must name the intended project's `master`, for example after
`fleet-telegram link acme-api/master`. The Telegram daemon and its existing
secret command must work, including sending to the owner's chat. Voice refuses
delivery when the link or Telegram guard is missing.

Run these commands yourself in a terminal outside an agent session:

```sh
fleet-voice token add scratch
fleet-voice token list
fleet-voice token revoke scratch
```

Use a distinct device name for each independently revocable installation.
Names accept letters, digits, underscores and dashes. On macOS `add` pipes the
new token to `pbcopy`, then prints only a confirmation. Paste from Universal
Clipboard into the iPhone import question. Never type, send or paste it into
chat. If clipboard delivery is unavailable, an interactive terminal displays it
once on its controlling tty. Redirected output and known agent sessions are
refused. `list` shows names, status and last use, never a bearer or hash. Revoke
before adding the same device name again. Revocation takes effect on the very
next request, including through the pair, without restarting either server.

Only the turn host stores device hashes, in private `voice-devices/` files under
the Telegram config directory. Separate last-use and revocation files prevent
a use from overwriting a concurrent revoke. The paired host stores no device
credential. It forwards the bearer inside the signed request body in memory,
using the same pair signature and replay checks as phone sign-in. Neither host
audits the envelope. The bearer is removed even if accidentally dictated. Never
put it in a URL, a command argument, a log, a notification or a shared Shortcut.

### Shortcut steps

A `cerebro.shortcut` was built in the worker scratchpad and signed with macOS
`shortcuts sign --mode anyone`. URL and token fields are empty, with two import
questions. The file stays outside this public repository. Signing succeeded on
macOS 27.0.1 on 2026-11-10; physical-device import and the questions remain
unverified. If import fails, use these steps:

1. Create a Shortcut named **cerebro**. Add two **Text** actions containing the
   complete URL and the device token pasted from Universal Clipboard. Name their
   outputs **Endpoint** and **Device token** to distinguish their magic variables.
2. Add **Dictate Text**, stopping **After Pause**. Choose a dictation language
   appropriate to the device's bilingual Siri/dictation setup. The recognizer
   must produce the actual question; the server cannot restore mistranscribed
   Spanish or English words.
3. Add **Get Contents of URL**, using **Endpoint** as the URL. Set **POST**,
   header `Authorization` to `Bearer ` followed by the **Device token** magic
   variable, and Request Body to **JSON**. Add a Text field `text` whose value is
   **Dictated Text**. Do not concatenate JSON strings.
4. Add **Speak Text**. For the text, select the **Contents of URL** magic
   variable, coerce it to **Dictionary**, and select the value for key `text`.
   For **Language**, use the same variable's value for key `lang`. These are
   variable property selections, not additional actions. Keep **Wait Until
   Finished** on. Leave **Voice** at its language default, rather than pinning
   an English voice. The signed file encodes both dictionary property selections.
5. Run once unlocked to grant microphone, speech recognition and network
   permissions. Enable **Show on Apple Watch** in Shortcut Details. Invoke it
   by name from Siri. Do not add Open App, SSH, JavaScript, shell or third-party
   actions. Do not share a configured copy containing the token.

The endpoint is `POST /api/voice/ask`. Use the paired host's existing trusted HTTPS
origin plus `/api/voice/ask?host=scratch`, where `scratch` is the turn host's **pair
key** from `fleet-serve pairs` on the paired host. Use this identical complete
URL on every device, including the Mac running the Shortcut. A direct caller
of the turn host may omit `?host=…`. Forwarding is one hop; the linked project
must be shared with the pair. Every device must reach that origin. Standalone
Watch routing to a private address has not been tested.

The JSON response is `{ "text": "…", "lang": "es" }` or `"en"`. This lets
Speak Text receive both the answer and its speech language without reading JSON
aloud or relying on its default voice to detect a language. The session is asked
for this wrapper, which the daemon removes before Telegram fallback delivery;
plain-text session answers are tolerated. The optional request field `lang`
accepts `es` or `en` to disambiguate the deadline sentence. Otherwise a small
Spanish-word heuristic chooses that sentence's language. The actual final
answer's language comes from the session, instructed to match the question.
Short or mixed questions and bilingual dictation need a physical-device check.

## The guard, queue and deadline

Voice is another inbound source of the Telegram daemon's own turn path. The
prompt begins `[telegram] [voice]` and asks for a few short spoken sentences in
the question's language, with no markdown or links. Keeping `[telegram]` first
preserves the existing prompt marker, armed reply address, guard and Stop relay.
A voice turn has the same tools as a Telegram turn. Voice has the **exact**
allowlist, command exceptions, scratch/checkout write
scope, unsupported-agent refusals and Codex opt-in/gap in [TELEGRAM.md](TELEGRAM.md).
By default it can read, search, browse, use fleet tools and write to scratch;
shell commands and checkout writes require the owner's Telegram exceptions.

A voice question queues behind a desk turn, permission dialog or another voice
turn. It never folds into a running turn. Telegram messages also queue behind a
voice turn. Configure the spoken instruction and HTTP deadline in the existing
Telegram config:

```sh
fleet-telegram config voice-tag '[voice] Answer in a few short spoken sentences, in the language of the question, with no markdown and no links.'
fleet-telegram config voice-deadline-ms 15000
```

The server-side default is **15 seconds**, including queue time. The setting
accepts 100–45000 ms; increasing it requires checking each device's timeout.
Before the deadline, HTTP returns the turn's final answer. After it, HTTP
returns one spoken sentence: “La respuesta te llegará por Telegram.” or “The
answer is coming on Telegram.” The turn continues and the final goes through
the bridge's own outbox to the owner's chat. A persisted, exclusive delivery
decision prevents the same final going to both HTTP and Telegram. Disconnecting
the HTTP waiter also yields to Telegram. Normal outbox retries and chunk
progress apply. Permission requests go to Telegram, separately from the final.
Private request/delivery files in `voice-requests/` are swept once a minute.
Submitted records with a delivery decision are removed 30 minutes after their
deadline, leaving ample time for the HTTP waiter and ordinary late answers.
A submitted record whose HTTP server died gets a Telegram fallback decision
once its deadline passes. After pruning, a later final still goes through the
normal Telegram outbox exactly once, with its JSON wrapper removed even without
`request.json`. The fleet-send queue is independent and is not pruned.
Unsubmitted, corrupt or incomplete records expire after a hard 24-hour file-age
cap, so a bad record cannot remain forever. Recent unsubmitted or queued records
are retained; submitted records are skipped by the 250 ms dispatch loop. Do not
publish the private request directory. Revocation prevents new requests; it does
not cancel an already authorized queued turn.

**Timeout evidence, checked 2026-11-10:** Apple's
[URLSession documentation](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest)
documents a 60-second request timeout default. This is a Foundation default,
not a Shortcuts guarantee. A
[firsthand Get Contents of URL report](https://www.reddit.com/r/shortcuts/comments/17yujri/get_content_of_url_timeout/)
dated 2023-11-19 describes a timeout after about one minute; another
[firsthand report](https://www.reddit.com/r/shortcuts/comments/1lru02o/the_get_content_of_url_action_timeout_error_when/)
dated 2025-07-04 also observes a 60-second limit. These are user observations, not an Apple
contract or a measurement on this setup. The author of a
[working Watch voice Shortcut](https://github.com/Boykot79/watchclaude#model-settings)
reports a roughly 30-second Watch network timeout. Fifteen seconds leaves room
below both figures. A scratch iOS 26.5 simulator had Shortcuts 7.0 installed,
but rejected a file URL passed to its import scheme as invalid; no timeout
measurement could be completed there. Siri/OS limits on physical devices remain
unmeasured and may be shorter.

## Device checks and the locked phone

This compatibility check is dated 2026-11-10 and uses documentation and primary
implementation evidence. It is not end-to-end hardware certification.

| Action | iPhone | Mac | Apple Watch |
| --- | --- | --- | --- |
| Dictate Text | Built-in speech input; After Pause | Built-in action; microphone/speech permissions and selected dictation language | Used by a working implementation; its author reports a **Done tap** may still be required |
| Get Contents of URL | JSON POST with Authorization | Apple documents JSON POST and variables | The same implementation uses a bearer-authenticated POST |
| Speak Text | Answer and language magic variables | Answer and language magic variables | Spoken output confirmed by that implementation |
| Text / If | Basic built-in actions | Basic built-in actions | Basic built-in actions; no complex app interaction needed |

The signed artifact uses only two Text actions, Dictate Text, Get Contents of
URL and Speak Text. None is known to be unavailable on these platforms. Apple
documents [API requests on Mac](https://support.apple.com/guide/shortcuts-mac/request-your-first-api-apd58d46713f/mac),
[variable properties](https://support.apple.com/guide/shortcuts/adjust-variables-apda36b9018b/ios),
[Watch Shortcuts](https://support.apple.com/guide/shortcuts/run-shortcuts-from-apple-watch-apd5888b0858/ios)
and [Mac dictation](https://support.apple.com/guide/mac-help/use-dictation-mh40584/mac).
The [Watch implementation's notes](https://github.com/Boykot79/watchclaude#apple-watch-shortcut)
provide primary evidence for the three actions and its Done-tap limitation. On
Mac, Dictate Text collects speech through the Mac microphone and returns text;
its microphone interaction, pause behavior and bilingual switching were not
exercised on hardware. On Watch, the reported Done tap means fully hands-free
use is **not established**. Standalone Watch network access also needs checking.

**Locked-phone finding:** Apple says a
[Siri shortcut that opens an app requires unlocking](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/ios).
This chain does not explicitly open an app. That supports the possibility of
locked operation when Siri/Shortcut lock-screen access is enabled, but does
**not** prove this exact chain works locked on the owner's iPhone. No physical
locked-phone test was available. Treat nearby speech as potentially able to
start a turn until tested. To keep a locked iPhone from starting a voice turn,
turn off Siri on the lock screen in the iPhone's Siri settings (Allow Siri When
Locked). The voice turn retains the same tools as a Telegram turn regardless of
locked-phone behavior; the allowlist does not change.

## Why HTTPS rather than SSH

The phone already reaches the paired host's `fleet-serve`; it has no route to
the turn host's sshd. SSH would need another phone network route, or a forced
command on the paired host SSHing onwards, Remote Login on the turn host and
another machine-to-machine key. A forced-command key needs every restriction
set correctly, and sshd's interfaces/accounts need separate hardening. HTTPS
adds one authenticated route to servers already listening; its bearer can only
ask the linked master one guarded question. Clipboard transfer preserves the
benefit of avoiding manual secret transcription. SSH on Watch also has
unresolved compatibility reports; no SSH path is built. The HTTPS action chain
has the implementation evidence above, with the dictation limitation stated.
