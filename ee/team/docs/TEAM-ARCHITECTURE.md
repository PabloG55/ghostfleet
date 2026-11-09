# ghostfleet team — architecture of the business edition

This document is the contract shared by the parallel pieces of work on `ee/team/`. If a piece of
work needs something that is not here, it says so in its report instead of inventing it.

## 1. One instance per company

- Each client company has **its own isolated server** (a VM or container in the cloud), with
  its own `GFW_DATA`. There are never several companies inside one process.
- **We** (the operator) create the instance and its **first admin** from the server's
  console: `node server/admin-cli.mjs create-admin <name>`, which prints a temporary password.
  There is no web screen for it: whoever reaches the port cannot make themselves admin.
- From then on, **the company's admin** (its IT) manages everything else from the
  `Administration` panel, which only admins see.
- SSO (Google Workspace / Microsoft Entra) comes later. Everything below is built on our own
  users with passwords, so that SSO plugs in on top without changing roles or permissions: the
  identity is `user.id`, wherever it comes from.

## 2. Users, roles and permissions

`users.json` (in `GFW_DATA`) holds, per user:

```json
{ "id": "ana", "name": "Ana", "color": "...", "salt": "...", "hash": "...",
  "role": "admin" | "member",
  "projects": { "acme-api": "admin" | "member" | "viewer" },
  "tokenCap": { "daily": 2000000, "monthly": 40000000 } | null,
  "disabled": false }
```

- **Global role**: `admin` sees and does everything, the panel included. `member` only what
  their projects give them.
- **Per-project role** (`projects`): a project that is not listed **does not exist** for that
  user: it does not appear in lists, the map, the board, the assistant, voice, or the options
  of an automation, and any route that names it answers 404 (not 403, so as not to confirm it
  exists).
  - `viewer`: reads sessions and their chat.
  - `member`: also sends prompts, attaches files, creates and stops workers in that project.
  - project `admin`: also assigns owners and manages the project's automations.
- **One point of control**: `server/access.mjs` exports
  `can(user, project, action)` with `action ∈ 'read' | 'prompt' | 'spawn' | 'stop' | 'assign' | 'manage'`
  and `visibleProjects(user, all)`. **Every** route, `perform()`, the voice dispatcher
  (`router.mjs`), the assistant and the automations go through it. Nothing decides
  permissions on its own. A prompt that tries to reach another project (by voice, through the
  assistant, or by asking a master to forward it) is refused in `perform()`, which is where it
  runs.
- **Existing installations** (retroactive): on boot, if users have no `role`, the first one
  becomes `admin` and the rest `member` with `member` on **every** project that exists at that
  moment, so that nobody loses what they see today. It is written once and stays in
  `users.json`.
- A `disabled` user cannot sign in, and their open sessions are closed.

## 3. The AI account: three modes

The work is always done with **Claude Code**. The admin picks the mode in
`Administration → AI account` (`GFW_DATA/settings.json`, key `ai`):

| mode | who pays | how usage is measured per user |
|---|---|---|
| `shared-subscription` — one subscription (Max/Ultra) for everyone | the company, flat plan | by the tokens of each user's turns, read from the transcripts |
| `api-key` — one Anthropic API key | the company, per use | the same, and it can also be expressed in money |
| `per-user` — each person with their own Claude account | each seat | the same; each user has their own profile and login |

- `shared-subscription` shows, when chosen, a warning the admin must accept: personal Claude
  subscriptions are for one person, and sharing them may go against Anthropic's terms; the
  usage limit is also split among everyone. Who accepted it and when is recorded.
- **Secrets**: an API key is kept in `GFW_DATA/secrets/` with `0600` permissions, is never
  returned to the browser (only `sk-…last4`) and is never written to a log.
- `per-user` relies on ghostfleet's **profiles** (one `CLAUDE_CONFIG_DIR` per profile): each
  user is linked to a profile, and the sessions they create start in that profile.
- **Codex and Gemini are not separate agents**: the admin can enable them as **MCP servers
  inside Claude** (`claude mcp add …` in the profile or profiles). Claude is still the one
  working, and consults them as a tool.

## 4. Token usage and caps

- `GFW_DATA/usage.jsonl`: one row per turn
  `{ts, user, project, session, model, input, output, cacheRead, cacheWrite}`.
  The turn is attributed to **whoever sent the prompt** that started it (the activity log
  already knows); a turn nobody on the web asked for (an automation) is attributed to its
  owner.
- Per-user caps (`tokenCap`, daily and monthly). On reaching the cap, `perform()` refuses that
  user's `prompt` and `spawn` with a clear message; reading keeps working. The admin has no cap
  unless they set one.
- The panel shows per user: today, week, month, per project, and the cap.

## 5. Automations

- Each automation has `scope: 'personal' | 'company'` and `createdBy`.
- **Personal**: any user creates one, only they (and the admins) see it, and it **runs with
  their permissions**: if they lose access to a project, their automations on that project are
  paused with a notice. Example: *"every day at 18:00, send me a summary of what happened today
  in my projects"*.
- **Company**: only an admin creates or edits one, everyone with access to its project sees
  it, and it runs with the permissions of the admin who saved it. Example: *"every Monday at
  9:00, ask acme-web's master to update the pricing page's data"*.

## 6. Visual identity

ghostfleet's personality is part of the product: the pixelated ghost submarine, the grid's
palette (xterm 203/114/80/221/245), boats that move, and status LEDs. The brand manual lives
in the repo's `brand/` (the core's, MIT, so the phone client can take the same look), and
the app takes its tokens from there.
