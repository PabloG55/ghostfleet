# Telegram: talk to a lead from your phone

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

**Link a session that runs `claude`.** The guard is a Claude Code hook, and codex,
opencode, agy and cursor never call it. A Telegram turn in one of them would have every
tool, so the daemon treats a session running another agent as unwired and delivers nothing.
It checks on every message, so a session switched with `fleet-agent` is covered both ways.

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
- `state.json`: the poll offset and the counts;
- `log`: one line per event, redacted;
- `outbox/`: answers waiting to be sent.

## What arrives, and how

| you send | the session gets |
| --- | --- |
| text | your words, as the owner (a `[telegram] ` prefix marks the turn) |
| a photo, or an image sent as a file | the caption, plus the path of the picture, stored where the phone client's photos go (`<fleet dir>/attach/<socket>.<session>/`), converted to JPEG or PNG when it is not one already |
| a voice note or audio | **with** `config transcribe-cmd`: the words. **Without** it: the path of the audio file, and a note telling the session it may not be able to listen to it and should ask you to type it |
| a sticker, a location, a contact… | nothing; the bot replies that it was not delivered |

A transcriber is any command that takes an audio file as `$1` and prints the words:

```bash
fleet-telegram config transcribe-cmd 'whisper-cli -m ~/models/ggml-base.bin -nt -f "$1"'
```

**A busy session queues your message**, exactly as `fleet-send` queues any prompt. The bot
tells you it is queued and runs next. The answer you get back belongs to **your** message's
turn, never to the one that was running when you sent it. The relay is armed by the
`UserPromptSubmit` that actually starts your turn.

## What comes back

- **The final message of your turn**, as a reply to your message. Markdown is converted to
  what Telegram renders: bold, italics, inline code, code blocks and links. Headings become
  bold lines, and tables arrive as code blocks. Anything over Telegram's 4,096-character
  limit is split into several messages, on paragraph boundaries where it can be, and a code
  block cut in two is closed and reopened.
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
arbitrary commands or write outside its own scratch folder. The default list:

| pattern | what it allows |
| --- | --- |
| `Read` `Glob` `Grep` `LS` `NotebookRead` | reading the checkout |
| `WebFetch` `WebSearch` | looking things up |
| `ToolSearch` `TodoWrite` | the agent's own bookkeeping |
| `mcp__ghostfleet__fleet_*` | the fleet tools: `fleet_send`, `fleet_spawn`, `fleet_list`, `fleet_read`, `fleet_inbox`, … and any fleet tool added later, such as a model switch |
| `Write:scratch` `Edit:scratch` `MultiEdit:scratch` `NotebookEdit:scratch` | writing, but only under `<fleet dir>/telegram/<socket>.<session>/` |

Anything else, `Bash` first of all, is refused. The refusal tells the model why and what to
do instead: delegate it with `fleet_send` to the session that should do it, or
`fleet_spawn` a worker, then tell you who has it. It also says that only you can widen the
list, from the desk.

Two rules apply on top of the list:

- **A fleet tool aimed at the same session is refused.** `fleet_send`, `fleet_answer` and
  `fleet_resume` all count. Otherwise the Telegram turn could queue its own shell command
  as the session's next prompt, which would run unrestricted.
- **A `:scratch` write needs an absolute path inside the scratch folder.** A path with a
  `..` in it, or one that is a symlink, is refused.

**How a turn is known to be from Telegram.** The daemon prefixes every prompt with
`[telegram] `. The fleet's `UserPromptSubmit` hook sees that and marks the turn
(`<fleet dir>/<socket>.<session>.telegram`), and the turn's `Stop` clears the mark. So the
next prompt, typed at the desk or queued by another session, runs exactly as it always
did. The guard costs one file check per tool call for every session that is not in a
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
each time.

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
- Only the allowlisted chat is served. Any other chat is dropped without a reply: the bot
  gives a stranger nothing to work with. The log records the chat id it came from, never
  the message text.

## Settings

| env var | default | for |
| --- | --- | --- |
| `GHOSTFLEET_TELEGRAM_DIR` | `~/.config/ghostfleet/telegram` | where its config, state, log and outbox live |
| `GHOSTFLEET_TELEGRAM_API` | `https://api.telegram.org` | the Bot API base URL, for a local Bot API server or a test stub |
| `GHOSTFLEET_TELEGRAM_POLL` | `50` | long-poll seconds per `getUpdates` (1–50) |
| `GHOSTFLEET_TELEGRAM_SERVICE` | `launchd` on macOS, `systemd` where `systemctl --user` works, else `pidfile` | force a service kind |

## When it does not work

- **`fleet-telegram status` first.** It checks every link in the chain in order: the link,
  the guard wiring, the secrets, the bot (`getMe`), the daemon and its last poll, the last
  error, and the outbox.
- **The bot says "Not delivered — … not wired".** The linked profile's `settings.json` is
  missing the guard. Run `./install.sh`.
- **"Not delivered — … it runs codex".** The linked session is not running `claude` (see
  step 3). Link a Claude session, or switch this one back.
- **Nothing at all comes back, and `status` counts drops.** The chat id you stored is not the
  one you are writing from. Read the `dropped from` line in the log.
- **`secrets: …`.** Run your secret command by hand with `token` or `chat` as `$1`. It must
  print exactly the value, and nothing else on stdout.
- **On macOS, `start` warns that it runs from `~/Documents`.** A launchd job cannot read
  files there (TCC). Run `./install.sh` and use the installed `fleet-telegram`, which runs
  from `~/.local/libexec/ghostfleet`.
- **The answer came back as plain text.** Telegram rejected the HTML for a chunk, and the
  daemon resent that chunk without formatting rather than lose it.
