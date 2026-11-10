# Telegram: talk to a lead from your phone

For Siri dictation through the paired host's HTTPS endpoint, see [VOICE.md](VOICE.md).
It uses this bridge's same guarded turn queue and final-message outbox.

`fleet-telegram` connects one Telegram chat to one fleet session, usually a project's
`master`. Write to the bot and your message lands in that session as **your** words. The
session answers, or hands the job to a worker with `fleet_send`/`fleet_spawn` and tells you
who has it. When its turn ends, its final message goes back to you in the same chat.

```bash
fleet-telegram config secret-cmd '<a command that prints the token or the chat id>'
fleet-telegram link acme-api/master
fleet-telegram start
fleet-telegram status
```

**Why the lead is the bot.** Before this, Telegram was a separate bot that forwarded each
message to a lead and then tried to relay the answer back. Two of four relayed messages got
no reply (FLOW-AUDIT-2026-11 S9). The forwarding worked; the failures were in getting the
answer back to the chat. Here there is no second hop to lose. The message goes in through
`fleet-send --owner --reply-to`, and the reply is the final message of the turn that prompt
started. The fleet's Stop hook picks it up, the same relay that answers a `--reply-to me`
question. Nothing scrapes a pane.

## Setting it up

### 1. Make a bot

In Telegram, open **@BotFather**, send `/newbot`, and pick a name and a username ending in
`bot`. BotFather replies with a **token**, `<digits>:<35 characters>`. Treat it like a
password: whoever has it can read your messages to the bot and send messages as the bot.

Optionally, still in BotFather, `/setcommands` and give it:

```
status - what the session is doing
help - what this chat is
```

The daemon answers these two itself, without starting a turn.

### 2. Keep the token and your chat id out of every file

`fleet-telegram` never stores either value. It runs a command you name whenever it needs
one, with `$1` set to `token` or `chat`, and reads the value from that command's stdout.
Store the values in your OS keychain first. Each line below prompts for the value, so it
never reaches your shell history.

**macOS** (Keychain):

```bash
security add-generic-password -a "$USER" -s ghostfleet-telegram-token -w
security add-generic-password -a "$USER" -s ghostfleet-telegram-chat  -w
fleet-telegram config secret-cmd 'security find-generic-password -a "$USER" -s "ghostfleet-telegram-$1" -w'
```

**Linux / WSL** (libsecret, from `libsecret-tools`):

```bash
secret-tool store --label='ghostfleet telegram token' service ghostfleet-telegram which token
secret-tool store --label='ghostfleet telegram chat'  service ghostfleet-telegram which chat
fleet-telegram config secret-cmd 'secret-tool lookup service ghostfleet-telegram which "$1"'
```

**Anywhere** (`pass`):

```bash
pass insert ghostfleet/telegram-token
pass insert ghostfleet/telegram-chat
fleet-telegram config secret-cmd 'pass show "ghostfleet/telegram-$1"'
```

`config secret-cmd` runs the command for both values before saving it, and says whether
they resolve. It **refuses** a command that contains the token itself, such as
`echo 7123…`, because the command is saved in `config.json` and a token inside it would be
stored in plain text.

**Your chat id.** It is a number. The quick way to find it: store `0` as the chat id, start
the daemon (step 4), and send the bot anything from your phone. Messages from every chat
but yours are dropped and logged by chat id, so the log line has your number:

```bash
grep 'dropped from' ~/.config/ghostfleet/telegram/log | tail -1    # dropped from 123456789
```

Store that number in place of the `0` (`security add-generic-password -U …` updates the
entry), then `fleet-telegram stop` and `start` again. A group chat's id is negative, and
that works too.

### 3. Link a session, and wire the guard

```bash
fleet-telegram link acme-api/master       # <project>/<session>, as in your projects list
```

A Telegram turn runs under a tool allowlist (below). The allowlist is a `PreToolUse` hook
that `./install.sh` wires into every Claude config dir. If the linked session's profile does
not have that hook, nothing is delivered: `link` warns you, `start` refuses, and a message
sent anyway gets a reply saying it was not delivered and why. Re-run `./install.sh` after
updating ghostfleet.

**Link a session that runs `claude`, or `codex` outside the work profile.** The guard is a
PreToolUse hook. Claude Code calls it from `settings.json`. codex calls it through its own
hooks: `hooks/codex-fleet-event.sh` hands every PreToolUse to the same guard, and codex blocks
the call on the guard's refusal. opencode, agy and cursor never call it. A Telegram turn
in one of those would have every tool, so the daemon treats such a session as unwired and
delivers nothing. It checks on every message, so a session switched with `fleet-agent` is
covered both ways.

**codex is off until you allow it.** One tool, `write_stdin`, never reaches the guard (see
the last item below), so a codex Telegram turn is held a little less tightly than a Claude
one. The daemon refuses codex sessions until you accept that, by adding
`"allow_codex": true` to `~/.config/ghostfleet/telegram/config.json`. Only a literal `true`
counts.

Once you allow it, the daemon checks each thing the guard needs for a codex session,
because nothing else holds the turn:
- the fleet is not a work profile's, where the codex bridge does nothing;
- the prompt, tool and stop hooks are in `$CODEX_HOME/hooks.json`, and their scripts exist;
- codex has them **trusted** in `config.toml`, since codex runs no hook it was not told to
  trust (`install.sh` records the trust; `node lib/codex-hooks.mjs status` shows it);
- codex has hooks turned on;
- the session's newest status record was written by those hooks. A codex session loads
  its hooks when it starts, so one started before `install.sh` wired them has none. Restart
  it, or give it one prompt at the desk.

Two things are different under codex:
- **Reading files.** codex reads files with its shell, and the default list has no shell, so
  a codex Telegram turn answers from what it knows and delegates the rest. A `Bash(…)` entry
  you add opens that command to it, as it would to Claude.
- **The model calls tools from a script.** codex's model runs its tools from a JavaScript
  `exec` tool. Each tool the script calls goes through the guard on its own, and a refused
  one fails the script with the guard's reason. The script has no network or filesystem of
  its own.
- **The Telegram rules outlive their turn in the model's memory.** The Telegram turn ends at
  its Stop, and the next desk turn has every tool again. But codex keeps the Telegram turn's
  context in the conversation, and after one Telegram turn the model declined a desk
  turn's shell command as "not permitted". Say it is a desk turn, or start a new session.
- **`write_stdin` is not checked.** It types into a process that an earlier turn left
  running, and codex sends no PreToolUse for it. A Telegram turn cannot start a shell, but it
  could type into one that a desk turn left open. This is why codex needs `allow_codex`; if
  it matters to you, leave it off and link a Claude session.

### 4. Run it

```bash
fleet-telegram start      # a launchd job on macOS, a systemd --user unit on Linux
fleet-telegram status     # link, guard, secrets, bot, daemon, counts, allowlist
fleet-telegram stop
```

`start` installs the same kind of service `fleet-serve` uses, so the daemon comes back after
a crash or a reboot. Where there is no `systemd --user` (WSL without systemd, a container),
it runs as a plain background process with a pidfile instead. `stop` kills that process by
its recorded pid, and only after checking the pid is still `fleet-telegram`. Neither unit
file contains a secret. The daemon fetches the secrets itself, through your command, when it
starts.

Its files are in `~/.config/ghostfleet/telegram/`:

- `config.json`: the link, the commands, the allowlist;
- `state.json`: the poll offset, the counts, and any messages still being held for one turn;
- `log`: one line per event, redacted;
- `outbox/`: answers waiting to be sent.

## What arrives, and how

| you send | the session gets |
| --- | --- |
| text | your words, as the owner (a `[telegram] ` prefix marks the turn) |
| a photo, or an image sent as a file | the caption, plus the path of the picture, stored where the phone client's photos go (`<fleet dir>/attach/<socket>.<session>/`), converted to JPEG or PNG when it is not one already |
| a document of any type, a video or a GIF | the caption, or `(a file, no caption)`, plus a line with the stored path, the original name, the type and the size: `file: <path> (report.pdf, application/pdf, 412 KB)` |
| a voice note or audio | **with** `config transcribe-cmd`: the words. **Without** it: the path of the audio file, and a note telling the session it may not be able to listen to it and should ask you to type it |
| a video note | **with** `config transcribe-cmd`: the words, like a voice note. **Without** it: a file, like a video |
| a reply to an earlier message | at the top, `(replying to an earlier message: "…")` with up to 400 characters of its text or caption, and what it had attached. A photo or a document it had is fetched and delivered too. This covers replies to the bot's own answers |
| a sticker, a location, a contact… | nothing; the bot replies that it was not delivered |

A caption is kept on everything that can carry one, voice notes included.

**Files.** A bot can download at most 20 MB, so that is the limit. Anything larger is refused
with a reply that says so and what to do: put it on the machine and send the path, or send a
smaller one. A file you replied to that cannot be fetched does not cost you your words: they
are delivered, and the session is told the file did not come through.

Files are stored in `<fleet dir>/attach/<socket>.<session>/files/`, readable only by you. Each
session keeps up to 200 MB of them (ten files at the limit, because an album arrives as one
message per item), and the oldest are deleted first. **The name you see is only ever data.** The
stored name is generated, and keeps the original's extension only when that is letters and
digits, at most 8 of them; anything else is `.bin`. The original name reaches the session on one
line, cut to 100 characters, and it is never written to the log.

An image sent as a file is treated as a photo when the photo store takes it. Past the photo
limit of 6 MB, or in a format it does not read (WebP, SVG), it arrives as a file instead.

### Several messages, one turn

A phone sends what you type as separate messages, often a second apart: a line, then the link
it is about. The daemon holds what you send until the chat has been quiet for 3 seconds, then
delivers all of it as **one** turn. The prompt has one `[telegram] ` prefix, then each message
in the order you sent it, with its quote, its words and its file line kept. The answer comes
back once, as a reply to the last of them, and as a voice note if any of them was one. The
typing indicator starts with your first message.

- **Nothing waits more than 30 seconds** from its first message, however fast you keep typing.
- **An album is always one batch.** Telegram delivers it as one message per photo, a few
  milliseconds apart, with the caption on the first. The turn gets the caption once and a
  `photo:` line for each picture.
- **`/start`, `/help` and `/status` are answered at once** and never held. A command first
  sends whatever you wrote before it, so `/status` sees that work already handed over.
- **A held message survives a crash.** Telegram forgets a message once the daemon has polled
  past it, and a batch has to poll to see what comes next, so the batch is written to
  `state.json` before that poll. A daemon that is stopped or dies inside the window hands the
  batch over when it starts again. If it dies after handing the batch over but before
  recording that, you get it twice rather than not at all.

```bash
fleet-telegram config coalesce-ms 5000   # wait for 5 s of quiet instead (at most 30000)
fleet-telegram config coalesce-ms 0      # each message is its own turn (an album is still one)
fleet-telegram config coalesce-ms ''     # back to the default, 3000
```

### Voice

Three settings, each off until you set it. You can use any of them without the others.

**`transcribe-cmd` turns a voice note into words.** It takes an audio file as `$1` and prints
the words. A video note reaches it as an MP4 and a voice note as an Ogg, so the command must
read both, which `ffmpeg`-based tools do.

```bash
fleet-telegram config transcribe-cmd 'whisper-cli -m ~/models/ggml-base.bin -nt -f "$1"'
```

**`speak-cmd` answers a voice note with a voice note.** It reads the answer on stdin and writes
an OGG/Opus file at `$1`. Telegram only plays OGG/Opus as a voice note.

**macOS** (the built-in `say`, with `ffmpeg` from Homebrew):

```bash
fleet-telegram config speak-cmd 'in="$1.aiff"; say -o "$in" -f - && ffmpeg -nostdin -loglevel error -y -i "$in" -c:a libopus -b:a 32k -f ogg "$1"; rc=$?; rm -f "$in"; exit $rc'
```

**Linux / WSL** (`espeak-ng` and `ffmpeg`):

```bash
fleet-telegram config speak-cmd 'espeak-ng --stdin --stdout | ffmpeg -nostdin -loglevel error -y -i pipe:0 -c:a libopus -b:a 32k -f ogg "$1"'
```

`$1` is in a private temp directory that is removed afterwards, and the command has 180 seconds to
finish. When a voice note, or a video note that was transcribed, comes in and `speak-cmd` is set:

- the turn is told its answer will be heard, so it writes it conversationally, in the language
  you spoke, with no markdown;
- the text answer goes first, always, as a reply to your message;
- then the command runs on that text, and the voice goes as a reply to your message too.

If the command fails, you still have the text. The failure goes to the log and never to the chat.
An audio file you sent as music rather than as a voice note is transcribed but not answered out
loud. A session waiting on you is never spoken either.

Whether an answer should be spoken is carried in its reply address (`telegram/v<id>`, not
`telegram/m<id>`), so it survives a busy session's queue and a daemon restart. If the daemon stops
in the middle of speaking, the next start speaks that answer without sending its text again.

**`voice-ack` says the voice note arrived.** Transcribing and answering can take a minute or more,
and the typing indicator fades after about 5 seconds. Set a short text and the daemon replies
with it the moment a voice note or a video note arrives, before it transcribes. It is the same
on macOS and Linux:

```bash
fleet-telegram config voice-ack 'Got it, listening.'
fleet-telegram config voice-ack ''      # off
```

`fleet-telegram status` shows whether each of the three is set, and `fleet-telegram config` shows
what it is set to. The daemon reads them on every message, so no restart is needed.

**A message to a session that is already working** goes one of two ways:

- **Into your own Telegram turn.** If the turn running is one you started from the phone,
  what you send now is more of the same request ("and the pricing page too"). It goes into
  that turn (`fleet-send --now`), and you get **one** answer that covers both, as a reply to
  your newest message. A message the turn has not read by the time it ends runs as the next
  turn instead, and then each turn answers its own message. Either way every message is
  answered exactly once, and quoting the right message.
- **After anything else.** A turn started at the desk, by another session or by the machine
  is never joined. Your message queues behind it, exactly as `fleet-send` queues any prompt.
  The bot tells you `<session> is working on something else; this runs right after it`. The
  turn your message starts opens with a line saying it was sent while an earlier turn was
  running. A session stopped on a question at the desk also queues: `--now` presses Enter,
  and Enter would answer the question.

The rule is there because of the [allowlist](#the-tool-allowlist-and-why). The guard holds a
turn to the phone's tools only while it is a **Telegram** turn. A turn started at the desk
runs with every tool the session has. Folding your words into it would let a message from
the phone use all of them, which is exactly what the allowlist exists to stop if the phone, or
the Telegram account, is not in your hands. A Telegram turn already runs under the
allowlist, so adding to it gives a message nothing it did not have.

Either way, the answer you get back belongs to **your** message, never to a turn that was
running for somebody else. The relay is armed by the `UserPromptSubmit` that starts your
turn. A folded message's address waits beside the running turn's own
(`<socket>.<session>.reply-to.fold`), and that turn's `Stop` reads the transcript to see
which messages it took in.

## What comes back

- **The final message of your turn**, as a reply to your message. Markdown is converted to
  what Telegram renders: bold, italics, inline code, code blocks and links. Headings become
  bold lines, and tables arrive as code blocks. Anything over Telegram's 4,096-character
  limit is split into several messages, on paragraph boundaries where it can be, and a code
  block cut in two is closed and reopened.
- **A voice note**, after the text, when your message was a voice note and `speak-cmd` is set
  ([above](#voice)).
- **A permission prompt** arrives as `<session> is waiting on you: …`. Answer it at the
  desk, or from the phone client.
- **Anything a session decides to tell you**, through `fleet-telegram send` or the MCP tool:

```bash
fleet-telegram send "**done**: the acme-web PR is open"
fleet-telegram send "the screenshot" --file /path/to/shot.png   # JPEG/PNG as a photo, anything else as a document
```

`fleet_telegram_send` (`text`, optional `file`) is the same thing as a tool, for an agent
that should message you on its own initiative. It is not for answering a Telegram turn,
which needs no tool: the final message already goes back.

## The tool allowlist, and why

A message from Telegram is you, but proven only by a chat id on a phone, not by you sitting
at the keyboard. A lost phone or a hijacked Telegram account should not get a shell on the
machine. So **a Telegram turn may only read, look things up and delegate.** It may not run
arbitrary commands or write outside its own scratch folder, unless you name a command or
the checkout on the list ([below](#letting-a-turn-run-a-command)). The default list:

| pattern | what it allows |
| --- | --- |
| `Read` `Glob` `Grep` `LS` `NotebookRead` | reading the checkout |
| `WebFetch` `WebSearch` | looking things up |
| `ToolSearch` `TodoWrite` | the agent's own bookkeeping |
| `mcp__ghostfleet__fleet_*` | the fleet tools: `fleet_send`, `fleet_spawn`, `fleet_list`, `fleet_read`, `fleet_inbox`, … and any fleet tool added later, such as a model switch |
| `Write:scratch` `Edit:scratch` `MultiEdit:scratch` `NotebookEdit:scratch` | writing, but only under `<fleet dir>/telegram/<socket>.<session>/` |

Anything else, `Bash` first of all, is refused. The refusal tells the model why, names what
the turn may use, and says what to do instead: delegate it with `fleet_send` to the session
that should do it, or `fleet_spawn` a worker, then tell you who has it. It also says that
only you can widen the list, from the desk.

Two rules apply on top of the list:

- **A fleet tool aimed at the same session is refused.** `fleet_send`, `fleet_answer` and
  `fleet_resume` all count. Otherwise the Telegram turn could queue its own shell command
  as the session's next prompt, which would run unrestricted.
- **A `:scratch` write needs an absolute path inside the scratch folder.** A path with a
  `..` in it, or one that is a symlink, is refused.

A list may hold several entries for one tool. The call is allowed if any of them covers it, so
`Write:checkout` added to the default list works beside `Write:scratch`.

**How a turn is known to be from Telegram.** The daemon prefixes every prompt with
`[telegram] `. The fleet's `UserPromptSubmit` hook sees that and marks the turn
(`<fleet dir>/<socket>.<session>.telegram`), and the turn's `Stop` clears the mark. So the
next prompt, typed at the desk or queued by another session, runs exactly as it always
did. The one exception is a message you sent into a Telegram turn that did not read it in
time. That message runs as the next turn, which no prompt hook announces, so the `Stop`
that hands it on marks that turn too. The guard costs one file check per tool call for every session that is not in a
Telegram turn.

**What the allowlist is not: a sandbox.** Work you delegate runs in the target session with
that session's own permissions. That is the point: you asked for it to get done. The list
stops the Telegram turn from doing that work **itself**. Every delegation goes through
`fleet_send`, and every `fleet_send` is visible in the fleet.

Changing the list:

```bash
fleet-telegram config allow Bash                    # add a pattern
fleet-telegram config allow 'mcp__acme_docs__*'     # globs work; quote them
fleet-telegram config allow --only Read Grep 'mcp__ghostfleet__fleet_*'   # replace the list
fleet-telegram config disallow WebFetch
fleet-telegram config allow --reset                 # back to the default
```

A change takes effect on the next tool call. No restart is needed: the guard reads the list
each time. `fleet-telegram status` shows the list, and where a `:checkout` entry writes.

### Letting a turn run a command

Plain `Bash` on the list gives the phone a shell. To let it run a few commands and nothing
else, name them, in the same syntax as Claude Code's permission rules:

| entry | allows | does not allow |
| --- | --- | --- |
| `Bash(bin/acme-api *)` | `bin/acme-api`, `bin/acme-api weekly "acme-web"` | `bin/acme-apix`, `./bin/acme-api`, `FOO=1 bin/acme-api` |
| `Bash(toolbox version)` | exactly `toolbox version` | `toolbox version --json`, `toolbox  version` |

```bash
fleet-telegram config allow 'Bash(bin/acme-api *)'   # quote them: the * and the space are part of it
fleet-telegram config allow 'Bash(toolbox version)'
fleet-telegram config disallow 'Bash(toolbox version)'
```

Spaces and tabs around the command are ignored. Past that, it is a plain string comparison.
A trailing ` *` means "and any arguments", on a word boundary. A `*` anywhere else is only
itself, so `Bash(*)` is not all of Bash, and `config allow` refuses it.

**The command must also be one plain command.** A prefix check alone would let
`bin/acme-api x; rm -rf ~` through, because it does start with `bin/acme-api`. So the
guard reads the command the way a shell will, and refuses any of these outside quotes:

| refused | because |
| --- | --- |
| `;` `&` `\|` and a line break | they end the command and start another |
| `<` `>` | they read or overwrite a file the arguments never named |
| `(` `)` | a subshell |
| `$` and a backtick | they run something, or expand into something else |
| `#` | a comment, which hides any quote in it from the shell: `x # '`, a line break, `rm -rf ~`, a line break, `# '` reads as one quoted argument and runs as three lines |

Also refused: `$` or a backtick inside double quotes, a quote that never closes, a backslash
at the very end or the end of a line, and anything over 32 KB, which is too long to check.

Everything inside single quotes is literal, and that is how a turn passes your words through:
`bin/acme-api note 'don'\''t ship $(this)'` is one command with one argument. A line break
inside quotes is fine too. `~`, `*`, `?`, `[` and `{` are not refused: they only change the
arguments, and the entry already trusts those.

**A command entry trusts that command with any arguments.** The guard checks that the shell
will run that one command, not what the command does with what it is given. So name only
commands that are safe with any input. Don't assume a read-only name is one:
`Bash(git log *)` looks harmless, and `git log --output=<file>` overwrites any file you can
write. The usual answer is a small script of your own that treats its arguments as data, and
an entry for that script.

A relative command like `bin/acme-api` runs from the session's working directory, so link
a session that sits where you expect, or name the command by its absolute path.

### Letting a turn edit its checkout

`:checkout` is a path scope like `:scratch`, for the session's own checkout:

```bash
fleet-telegram config allow Write:checkout Edit:checkout MultiEdit:checkout NotebookEdit:checkout
```

**Where the root comes from: the fleet's records, never the turn.** The agent can `cd`, so
the working directory the hook is told about proves nothing.

- The start is the project's directory in your projects list, found by the session's socket.
- A session started in a worktree that git lists for that project has that worktree as its
  root, and not the main checkout. The `acme-web` worker in its own worktree edits its
  worktree.
- A session started anywhere else has no root. That can happen after a restart, which
  recreates a session from wherever its pane was.
- `$HOME`, or anything above it, is never a root, even if a project is registered there.

**When no root can be found, every `:checkout` write is refused**, and the refusal says so.
`fleet-telegram status` shows the root it found, or that there is none.

A path must be absolute and resolve inside the root. A `..` or `.` in it is refused. So is a
symlink at the path, a symlink on the way to it that leaves the root or points at nothing, and
any path through a `.git` directory. `.git` is inside the root but it is not the checkout: it
never appears in `git status` or a diff, and it decides what runs. With `Bash(git log *)` on
the list, a write to `.git/config` that sets `diff.external` makes the next
`git log -p --ext-diff` run whatever it names.

**`:checkout` and a command entry can add up to a shell.** Everything else in the checkout
stays writable, and that includes what runs. If `Bash(bin/acme-api *)` is on the list and
`bin/acme-api` is in the checkout, a turn can rewrite the script and then run it, or edit
what it imports. That turns a message into a remote shell, and the guard cannot tell that
edit from any other. Hooks in `.claude/settings.json`, `package.json` scripts and a
`Makefile` are the same thing with a delay. So choose one: keep the commands you allow outside
the folder the phone can edit, or decide you are comfortable with what that combination means
if the phone is lost.

## Secrets

- The token and chat id live only in your keychain, or wherever your command reads them.
  They are never in `config.json`, `state.json`, a unit file, a log line or an outbox
  record.
- They are never in a process's arguments. The daemon gets them from your command's stdout.
  The suite runs the whole loop against a stub API and samples `ps` while it runs, to check
  this.
- The token is part of every Bot API URL, and an HTTP error can quote the URL it failed on.
  Every line the daemon logs, prints or sends back to the chat goes through redaction
  first. A Telegram error that quoted the token reaches you with the token removed.
- A prompt is an argument to `fleet-send`, so a token in a message, a caption, a quote or a file
  name is redacted before it gets that far. So is an answer on its way to `speak-cmd`, which reads
  it on stdin and never as an argument.
- Only the allowlisted chat is served. Any other chat is dropped without a reply: the bot
  gives a stranger nothing to work with. The log records the chat id it came from, never
  the message text.

## Settings

| env var | default | for |
| --- | --- | --- |
| `GHOSTFLEET_TELEGRAM_DIR` | `~/.config/ghostfleet/telegram` | where its config, state, log and outbox live |
| `GHOSTFLEET_TELEGRAM_API` | `https://api.telegram.org` | the Bot API base URL, for a local Bot API server or a test stub |
| `GHOSTFLEET_TELEGRAM_POLL` | `50` | long-poll seconds per `getUpdates` (1–50) |
| `GHOSTFLEET_TELEGRAM_SPEAK_TIMEOUT` | `180` | seconds `speak-cmd` may run before it is stopped; it holds the outbox while it runs |
| `GHOSTFLEET_TELEGRAM_SERVICE` | `launchd` on macOS, `systemd` where `systemctl --user` works, else `pidfile` | force a service kind |

The window for [several messages, one turn](#several-messages-one-turn) is a `config` key, not
an environment variable: `fleet-telegram config coalesce-ms <0-30000>` (3000 by default).

## When it does not work

- **`fleet-telegram status` first.** It checks every link in the chain in order: the link,
  the guard wiring, the secrets, the bot (`getMe`), the daemon and its last poll, the last
  error, and the outbox.
- **The bot says "Not delivered — … not wired".** The linked profile's `settings.json` is
  missing the guard. Run `./install.sh`.
- **"Not delivered — … it runs opencode"** (or agy, or cursor). The guard cannot run there
  (see step 3). Link a Claude or codex session, or switch this one back.
- **"Not delivered — … it runs codex, whose write_stdin … never reaches the guard"**. Telegram
  to codex is off (see step 3). Link a Claude session, or add `"allow_codex": true` to the
  config.
- **"Not delivered — … codex's PreToolUse hook is untrusted"** (or missing, or "have not
  reported from this session").
  - Run `./install.sh` and read `node <runtime>/lib/codex-hooks.mjs status`.
  - Restart a codex session that was already running when you installed.
  - If codex asked "Hooks need review" and you chose to continue without trusting, the hooks
    are off for that session.
- **Nothing at all comes back, and `status` counts drops.** The chat id you stored is not the
  one you are writing from. Read the `dropped from` line in the log.
- **`secrets: …`.** Run your secret command by hand with `token` or `chat` as `$1`. It must
  print exactly the value, and nothing else on stdout.
- **On macOS, `start` warns that it runs from `~/Documents`.** A launchd job cannot read
  files there (TCC). Run `./install.sh` and use the installed `fleet-telegram`, which runs
  from `~/.local/libexec/ghostfleet`.
- **The answer came back as plain text.** Telegram rejected the HTML for a chunk, and the
  daemon resent that chunk without formatting rather than lose it.
- **A voice note gets a text answer but no voice.** Read the `speak-cmd failed` line in the log.
  It gives the exit status, and says when the command wrote no file or wrote something that is
  not an Ogg file. To try the command by hand: `echo hello | sh -c '<your command>' x /tmp/out.ogg`.
