# ghostfleet team

This folder is under the [ghostfleet Team License](../LICENSE), not the MIT license of the rest of the repo.

The Claude Code fleet of [ghostfleet](https://github.com/PabloG55/ghostfleet), in the browser and
for a small team: clicks instead of commands, an owner for every session, and a voice assistant
that hands out the work.

It does not replace ghostfleet: it uses it. It reads the fleet with the same pieces as `fleet-serve`
(`fleet-grid.mjs --json`, `fleet-read --json`, `tmux capture-pane`) and acts through ghostfleet's
dispatcher (`mcp/fleet-dispatch.mjs`), with the same validations.

## Getting started

```bash
pnpm install
pnpm build

pnpm demo     # sample data in memory, to show it off without touching anything real
pnpm start    # your real fleet (needs ghostfleet installed)
```

Open <http://127.0.0.1:8790>. The first account (the admin) is created from the server's console:
`node server/admin-cli.mjs create-admin <name>` (with `--demo` for the demo), which prints a temporary
password. That admin creates the rest of the team in **Administration → Users**, with their role in each project.

Up to 2 accounts are free. A third needs a subscription key, pasted by an admin in **Administration → License**;
creating or re-enabling an account beyond the seats is refused with a message that says so, and so is `create-admin`
on the console. Nobody who already has an account is locked out when a key expires. What the server counts, and the
one daily request it makes once a key is stored, are in [`docs/LICENSING.md`](../../docs/LICENSING.md). The demo is not limited.

For development with hot reload: `pnpm dev:demo` or `pnpm dev`, and open <http://127.0.0.1:5190>.

| Variable | What for | Default |
|---|---|---|
| `GHOSTFLEET_HOME` | where ghostfleet is installed | `~/.local/libexec/ghostfleet` |
| `GFW_PORT` / `--port` | port | `8790` |
| `GFW_BIND` / `--bind` | interface: only `127.0.0.1` or a Tailscale IP | `127.0.0.1` |
| `GFW_DATA` | accounts, owners, activity and the license key | `~/.config/ghostfleet-web/<mode>` |

## What it has

- **Home**: what needs attention across every project, yours first.
- **Project**: the sessions grouped into *Need you / Working / Ready for review / Paused*,
  filters by person, free worktrees, and the *New session* wizard.
- **Session**: the conversation as a chat (with who sent each instruction), the live terminal,
  permissions as buttons (*Yes, allow / No*), and pause, interrupt, rename and stop.
- **Attach files or images** in any session's chat: the paperclip button, drag or paste (up to 10 per
  message, 25 MB each). They are stored where ghostfleet stores the phone's photos
  (`$CLAUDE_FLEET_DIR/attach/<socket>.<session>/`, limited to 200 MB per session) and the message passes their paths.
- **Automations** (n8n-style, in the menu): a trigger and actions in order, assembled by dragging
  blocks (or tapping them, on a phone) or by asking for one in a sentence in the AI tab, which fills in the
  same blocks for you to review before saving.
  - *Triggers*: at a time (certain days, once, or every N minutes/hours) or a session
    event (finishes, needs you, starts, runs out of quota, goes down), with a minimum interval between
    firings for the same session.
  - *Actions*: send a prompt, create a session, pause, resume, wake, interrupt, reopen,
    stop (asks for confirmation when saving), *continue only if…* the session is in a given state, notify me, and
    wait. In prompts and names: `{fecha}` `{hora}` `{proyecto}` `{sesion}` (date, time, project, session).
  - They run under the name of whoever created them and through the same checks as a click (they show up in
    *Activity* with a bolt mark). Each one is *personal* or *team*.
  - **If the server was off at the scheduled time**, it does not run late: it is marked *skipped* and you are notified.
    One that fires 30 times in an hour switches itself off (a loop) and says so.
  - The AI is a single-turn `claude -p`, with no tools and no MCP, that only writes the draft;
    it does not stay open using memory.
- **Owner and presence**: every session has an owner, and you can see when someone else is looking or typing.
- **Activity**: everything that was done, with name and time.
- **Voice assistant**: everything you say goes first through a dispatcher (`server/router.mjs`, a
  single-turn `claude -p` that sees the recent conversation and the fleet), which splits what was said into tasks
  and gives each one **a single destination**: a project's lead or a named session. If it is not sure,
  or if something fails, the task is kept asking where it goes, without being sent. Every decision lands in
  *Activity* with its reason. Whatever cannot be told from the names
  is explained to it in `<data>/router-notes.md` (which project handles what). The boat sails to the session where it is working and, with
  *Follow it live*, the screen goes with it. It answers out loud and has a hands-free mode.
  Commands that only move the page do not go through Claude: “muéstrame el mapa” (show me the map), “abre la sesión billing” (open the billing session).
- **Requests** (the side list, on any page): every task asked of the assistant, with its project and
  its state (*where to?, sent, working, needs you, replied*) and what came back. It is stored
  on the server, per person (`tasks.json`), and follows the replies of every project at once; each
  reply is read out saying where it comes from, one after another. A task leaves the list when you
  tick it with ✓. Stray comments (“perfecto”, perfect) are sent but take up no row.
- **Live map**: every project as an island and its sessions as boats in the colour of their status;
  the ghost ship flies to wherever something just happened, in any project, with a live log.
- **Labels and scheduled messages**: a label like *urgente cliente* (urgent client), or “write *continúa* (continue) to it tomorrow at 9”.
  When a session hits its usage limit, a button schedules it to resume on its own when the
  quota comes back. They are stored in the same markers as ghostfleet's grid, so they also show
  in the terminal.

## Voice

**Local first.** If the machine has whisper.cpp and Kokoro (the same ones ghostfleet's Jarvis
uses), speech is transcribed and spoken here: the audio never leaves the machine and it works in any
browser. They are detected on their own:

| | where | how to install |
|---|---|---|
| whisper.cpp (hearing) | `~/.local/share/whisper/whisper-cli` + a `ggml-*.bin` | build [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and download `ggml-small.bin` (multilingual) |
| Kokoro (speaking) | `~/.local/share/kokoro` | `fleet-jarvis voice --kokoro --install`, or ghostfleet's `lib/kokoro-setup.mjs` |

Both at once, in your home directory and without `sudo` (needs git, cmake, a C++ compiler and `uv`):
`bash scripts/install-voice.sh`.

Whisper's language is Spanish (`GFW_VOICE_LANG` to change it).

**When you have finished speaking** is decided by [Silero VAD](https://github.com/snakers4/silero-vad) in the
browser (via [`@ricky0123/vad-web`](https://github.com/ricky0123/vad), the same detector
[Handy](https://github.com/cjpais/Handy) uses): it recognises a human voice instead of measuring volume, so a
breath, the keyboard or a fan do not count as speech, and a pause to think does not cut you off.
Each person picks *When I pause* in the assistant: 2.5 s, 4.5 s, or never cut and wait
for *✓ I'm done*. Its files (model, worklet and onnxruntime's wasm, ~17 MB, downloaded once)
are served by this same server: `pnpm build` copies them with `scripts/copy-vad.mjs`. If they do not load, a
volume meter remains as a fallback.

**Voices to choose from**, in the assistant's *Voice options*: Kokoro's three Spanish voices and, from the internet, those of
[Piper](https://huggingface.co/rhasspy/piper-voices). Those can be previewed and are downloaded with one click
(~60 MB each; the first one also installs `piper-tts` in `~/.local/share/piper` with `uv`, and every
file is checked against the catalogue). They are available to everyone; each browser remembers its own. They only change
the Spanish phrases: the English ones are still read by Kokoro.

**If there is no local voice**, the browser's is used: dictation works in Chrome and Edge (online,
because Chrome processes it on its servers) and reading aloud with `speechSynthesis`.

## To propose to ghostfleet

Labels and scheduling are written today by ghostfleet team imitating `fleet-grid.mjs`, which is their
only owner (that is why `fleet-serve` refuses them). The right shape is a ghostfleet command that owns
those markers (`<sock>.<session>.label` and `.sched`) with `fleet_label` / `fleet_schedule` MCP tools
on top; then this server calls them like the others. While at it: `bin/fleet-schedule`
deletes `<session>.sched` without the socket in front, which is not the marker the grid writes (harmless,
because the grid ignores past times, but it leaves the file behind).

## Security

Like `fleet-serve`, this is **remote code execution by design**: sending a task to an
agent is running commands on this machine.

Project grants protect the browser and API routes: a viewer can read, a member can prompt,
and an admin can manage access. They do not isolate code run by a prompted session. A member
who can prompt runs commands as the session's OS user. If sessions share the server's OS user,
they can edit `GFW_DATA/real/users.json` (which the server re-reads on change), read `secrets/`
and `license.json`, and reach other projects' tmux sockets. A project grant is not a boundary against shell access.

Run the server as a dedicated OS user and arrange permissions so its sessions cannot read `GFW_DATA`
(the sessions must run with a separate OS identity or equivalent isolation). Otherwise, give members
only projects you would trust them with in a shell, including everything that OS user can reach.

The bind guard accepts `100.64.0.0/10`. Tailscale and carrier-grade NAT share that range, so the
range cannot tell them apart or prove that a connection came through Tailscale. Restrict who can
reach the listener with your network configuration.

The HTTP controls are:

- it only listens on loopback or the accepted tailnet address ranges;
- it only answers to the names it is reached by (`127.0.0.1`, `localhost`, the `--bind` IP and those in
  `GFW_HOSTS`, e.g. a MagicDNS name): a foreign page that points its domain at this machine (DNS rebinding)
  gets 403;
- no account can be created from the web: the first admin comes from `server/admin-cli.mjs` on the
  server's console, and every account after that from the admin panel, so reaching the port is not enough to take over the fleet;
- everything requires a signed-in session; passwords are stored with scrypt and the cookie is `HttpOnly` + `SameSite=Strict`;
- every write lands in the activity log with the name of whoever made it;
- stopping or deleting worktrees asks for confirmation (and for typing the name, when it deletes);
- a permission is only answered if the request you saw is still on screen (the request's fingerprint).

**What the server sends out on its own.** One thing: once a license key is stored, a daily `POST` of that key, and
nothing else, to the license service, to pick up a renewed key (also on **Check now**). A returned key is installed
only if its signature verifies and it is a later key of the same license; the answer cannot unlock anything else. An
admin switches it off in **Administration → License**, and a build whose `RENEW_URL` (`ee/seats/public-key.mjs`) is
empty never makes the request. The license key is stored in `GFW_DATA` with mode 0600 and is never sent back to a
browser. The seat limit is a licensing check, not a security boundary: it is asked only when an account is added.

To use it from outside this machine: Tailscale and `--bind <tailscale-ip>`.
