# Ideas — names

> **Chosen: `ghostfleet`.** A ghost fleet is a fleet of autonomous, unmanned vessels
> under one command — agents with nobody in the seat, one control plane steering them.
> Applied to the visible surfaces (TUI headers, README). The CLI entry point, the
> `fleet-*` commands, `~/.config/claude-fleet/`, `~/.local/libexec/claude-fleet/` and the
> `cf-<project>` sockets are deliberately unchanged — see "Renaming cost" below.

One-word name candidates for the tool currently called **claude-fleet**.

What the name has to carry: *one control plane commanding many parallel Claude
sessions* — projects → a lead → workers on their own git worktrees. So the strong
metaphors are fleets (many craft, one command), crews, and parallel threads.

Collision notes are from memory, not a registry check — verify before committing to
one.

## Shortlist

| Name | Why it fits | Collision risk |
| --- | --- | --- |
| **Regatta** | Many independent craft racing in parallel, one start line. Closest metaphor to the grid: everything moving at once, you watching the field. | Low — no known dev tool |
| **Flotilla** | A fleet of *small* craft — exactly what workers are. Keeps the fleet DNA without being generic. | Low |
| **Muster** | To assemble and call up a force. It's a verb, so it reads as an action: `muster acme`. | Low |
| **Loom** | Many parallel threads woven into one piece — the truest description of what the tool does. Short, memorable. | Medium — Loom (video) is a big brand, different space |
| **Yard** | A shipyard / rail yard: where the worktrees sit and get routed. Short, concrete, unpretentious. | Medium — common word |
| **Bridge** | The ship's bridge *is* a control plane. Instantly understood. | Medium — very generic term |
| **Armada** | Bold, unmistakably a fleet. Good if you want it to sound big. | Medium — an Armada k8s batch project exists |
| **Helm** | You sit at the helm and steer. Best "control plane" word there is. | **High** — Helm (Kubernetes) owns this in devtools |

## Keeps the fleet DNA (agent-fleet flavored)

| Name | Why it fits | Collision risk |
| --- | --- | --- |
| **Commodore** | The rank that commands *a fleet*, not one ship — each project's master is a captain, you're above them. Exactly the hierarchy the tool has. | Low in devtools (retro-computer brand, different space) |
| **Flagship** | The lead vessel of a fleet — literally what a `master` session is. Fleet meaning baked into the word. | Low |
| **Squadron** | A fleet unit: a handful of craft operating together under one command. Crisp, unambiguous. | Low |
| **Carrier** | Launches many craft and recovers them — matches spawn → work → land. | Medium (generic / telecom) |
| **Bosun** | The one who directs the crew's actual work while the captain commands. Short, rare, nautical. | Low |
| **Convoy** | A group moving together under escort; emphasizes coordination over speed. | Low |
| **Fleetctl** | Most literal option, matches the `fleet-*` command prefix. | **High** — CoreOS shipped `fleet`/`fleetctl` (cluster manager) |

## Fleet compounds

Worth knowing before picking: bare **Fleet** is taken twice in devtools — JetBrains
Fleet (IDE) and Fleet DM (osquery device management) — so a compound isn't just
flavor, it's what makes the name searchable.

| Name | Why it fits | Collision risk |
| --- | --- | --- |
| **Codefleet** | Says exactly what it is: a fleet of coding agents. Clearest of the lot. | Low |
| **Ghostfleet** | "Ghost fleet" is the real term for a fleet of *autonomous, unmanned* vessels — i.e. agents working without a human aboard. Best metaphor + most memorable. | Low |
| **Fleetwright** | One who builds fleets, in the shipwright / Playwright family. Reads like a devtool. | Low |
| **Agentfleet** | Most literal reading of "agent fleet". Descriptive, a little flat. | Low (generic) |
| **Fleetgrid** | The UI *is* a grid of session cards — describes what you look at all day. | Low |
| **Fleetforge** | Forge = where the work gets made; pairs with worktrees. | Low |
| **Starfleet** | Instantly memorable, everyone gets it. | **High** — Paramount trademark |
| **Fleetsmith** | Good shape, but Apple acquired and retired a Fleetsmith (MDM). | Medium — burned name |
| **Fleetdeck** | Flight deck / deck of cards, both apt. | Medium — fleetdeck.io exists |

## Also considered

- **Cohort**, **Squadron**, **Convoy**, **Wing** — group-moving-together words; fine
  but less distinctive.
- **Swarm**, **Hive**, **Colony** — right idea (many agents), but Docker Swarm and
  OpenAI Swarm make this crowded, and "swarm" implies undirected, which is the
  opposite of a lead dispatching briefs.
- **Foreman**, **Wrangler**, **Shepherd**, **Overseer** — the "runs a crew" angle;
  Foreman (Ruby / theforeman.org) and Wrangler (Cloudflare) are taken.
- **Maestro**, **Conductor**, **Baton** — orchestration metaphor; Maestro is a mobile
  UI-testing tool.
- **Switchyard**, **Junction**, **Depot**, **Berth**, **Marina** — routing/parking
  metaphors, a bit long or oblique.

## Pick

**Commodore** if the name should say *fleet command* — it's the only word here that
means "commands multiple ships", which is precisely the projects → masters → workers
hierarchy. `commodore acme` reads like an order.

**Flagship** is the close second, and the most self-explanatory: the lead session IS
the flagship.

**Regatta** if you want distinctive and collision-free — many craft in parallel, and
nothing in devtools owns the word.

**Flotilla** if you want to keep the literal fleet meaning.

**Helm** is the best *word* for a control plane, and the worst *choice* — Kubernetes
Helm will bury it in every search.

Keeping **claude-fleet** is also defensible: it says exactly what it is, and the
`fleet-*` command prefix (`fleet-spawn`, `fleet-open`, `fleet-governor`) is already
consistent and typo-friendly. A rename means renaming ~20 commands and the config
paths, so the new name should be clearly better, not just newer.

## Renaming cost (why the CLI kept its name)

The product name and the command names don't have to match, and here the split is
deliberate: a full rename touches live state, not just strings.

- ~20 commands on `PATH` (`fleet-spawn`, `fleet-open`, `fleet-governor`, …)
- `~/.config/claude-fleet/projects[.<profile>]`
- `~/.local/libexec/claude-fleet/` (the staged runtime `cf-sync` writes to)
- `~/.claude*/fleet/` — status files, park/sched markers, inboxes, governor pidfiles
- `cf-<project>` tmux sockets, which name every RUNNING session
- the hook path wired into every profile's `settings.json`, and the MCP registration

Renaming the paths/sockets while a fleet is live would orphan running sessions,
markers and governors. If it's worth doing, do it deliberately: add the new names as
symlinks first, keep the old ones working, migrate state on an idle fleet.
