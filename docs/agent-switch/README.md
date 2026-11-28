# Switch agent

A running session can move to another agent, Claude Code or Codex, without losing its
thread. It keeps its name, its worktree and its branch. The new agent is handed a budgeted
selection of the conversation, not a summary (`lib/handoff.mjs`). A session that goes back
to an agent it ran before picks up that agent's own conversation, and is handed only what
happened since. A switch asked for in the middle of a turn waits for the turn to end.

There are three ways to ask for one:

- **CLI:** `fleet-model <session> codex[:<model>]` or `claude[:<model>]`, with `--message`
  for what to send after it.
- **MCP:** `fleet_model` with `model: "codex:<model>"` and an optional `message`.
- **Phone or desk:** the session page's **More › Switch agent…**. It opens a bottom sheet on a
  phone and a centred dialog at a desk. Nothing is added inline. The sheet lists each agent's
  models from `fleet-model --models`, so it never offers one the switch would refuse.

After a switch, the session's header names the agent it runs. While a switch is waiting on a
turn, the header names where the session is going; a phone has no room for that, so it is in
More instead.

## Screenshots read

Every image was opened and read. They show demo data only: the demo banner, acme-api and its
fixture sessions, and `web/fixtures/models.json`. Their digests are recorded in
`test/helpers/name-sweep.mjs`.

- `phone-390-switch-sheet.png`: More › Switch agent on master at 390. It is a bottom sheet with
  Claude Code's models above Codex's. The one the session runs is marked "now", and the button
  names the pick: Switch to Codex · GPT-6.2-Sol.
- `phone-390-after-switch.png`: master after the switch. The header says `codex` beside Ready.
- `phone-390-waiting-more.png`: a working session (list-pages) asked to move to claude. The
  switch waits for its turn, and More says so: "Moves to claude (sonnet) when its current turn
  ends".
- `desk-1280-switch-dialog.png`: the same sheet at 1280, as a centred dialog, with the two
  agents side by side and the optional message filled in.
- `desk-1280-after-switch.png`: master after the switch. `codex` is on the header and on its
  card.
- `desk-1280-waiting.png`: list-pages while its switch waits. The header shows
  `→ claude (sonnet)…` beside `codex`.
