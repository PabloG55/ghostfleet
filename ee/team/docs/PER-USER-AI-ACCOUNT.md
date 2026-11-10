# Per-user AI account (`per-user`): what exists and what is missing

Contract §3: in `per-user` mode each user is linked to a ghostfleet profile (a
`CLAUDE_CONFIG_DIR`), and the sessions **they** create start in that profile. This round
delivers the data and the screen; it does not deliver the launching, because that cannot be
done properly from `ee/team/` without changing ghostfleet. This document says why, and what
change is needed.

## What already exists

- `GFW_DATA/settings.json` → `ai.perUser`: `{ "<user.id>": "<profile>" }`. The profile is a
  ghostfleet profile name (`work`, `personal`, …; `[A-Za-z0-9_-]{1,40}`), the same one that
  appears in `~/.config/ghostfleet/projects.<profile>`; its config dir is resolved by
  `lib/projects.mjs cfgFor`.
- `Administration → AI account → Per-user account`: one picker per person, and each profile's
  login (who, which plan), read without touching tokens.
- Choosing `per-user` mode is saved and removes the company's `apiKeyHelper` from the
  profiles, so that each profile uses its own login.

## Why it is not applied yet

A project lives in **one** fleet, and the fleet belongs to **one** profile: its socket is
`cf-<profile>-<project>`, and `fleet-spawn` rewrites `CLAUDE_CONFIG_DIR` and `CLAUDE_FLEET_DIR`
with those of the profile that owns the socket (`bin/fleet-spawn`, "THE SOCKET IS FINAL; NOW
THE FLEET'S OWN PROFILE"). That is deliberate: a worker with another profile's config dir wrote
its markers into the wrong directory, and every session opened after it inherited the error.

So today, even if the server passed a different `CLAUDE_CONFIG_DIR` at launch, `fleet-spawn`
would overwrite it. And if it did not, the session would fall out of view: its transcript goes
to `<its config dir>/projects/`, which is where `fleet-read` and the grid do **not** look for
that fleet, and its usage reading lands in another profile's meter.

## The change that is needed (in ghostfleet, not in ee/team/)

Separate two things that are one today: **which fleet** the session belongs to (socket, fleet
dir, state, markers) and **which account** Claude runs on inside it (config dir: login,
transcripts, settings).

1. `fleet-spawn --account-dir <dir>` (and an `account` field on `fleet_spawn`): leaves
   `CLAUDE_FLEET_DIR` as the fleet's and sets `CLAUDE_CONFIG_DIR=<dir>` only in the
   `new-session -e` of THAT session, not in the tmux server's global environment.
2. Record it in the session's registry (`<fleet dir>/<sock>.<session>.account`) so that
   `fleet-restart`, `fleet-resume`, waking and `fleet_reopen` relaunch with the same dir.
3. `fleet-read`, the grid and `fleet_model` look for the transcript in the session's config
   dir when it has one of its own.
4. The usage meter (status line) labels its reading with the real config dir.
5. Trusted folders (`hasTrustDialogAccepted`) live in the config dir's `.claude.json`: each
   person's profile has to trust the project's worktrees, or the first launch stalls on the
   trust dialog.

## What `ee/team/` will do once that exists

- In `perform()`, for `fleet_spawn` (and relaunches) by a user with `ai.perUser` in
  `per-user` mode: add `account` with `cfgFor(profile)`. An automation runs with its owner's
  profile (contract §5).
- Each person's login: a "Connect my Claude account" tab that opens `claude` with their
  `CLAUDE_CONFIG_DIR` in a terminal session of their own to run `/login`. Today it is done
  from the server's console.
- No profile assigned in `per-user` mode: refuse `spawn` with a clear message ("ask the admin
  to assign you an account"), the same as the token cap (§4).
