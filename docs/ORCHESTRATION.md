# Orchestration: a lead session driving workers

Split out of the README, which had grown to the point where the three reference sections
were 78% of it. This is one of them, unchanged apart from its links.

The keys and screens are in [SHORTCUTS.md](SHORTCUTS.md); the operational edges — adopting
hand-run sessions, the phone, notifications, profiles — are in
[OPERATIONS.md](OPERATIONS.md).

Because every session lives on the same tmux socket, a "lead"/**master** session can dispatch
work to siblings, watch them, unblock them, and manage cost — turning a fleet into
lead-and-workers (e.g. an `api` lead handing briefs to `api-1` / `api-2` worktrees). All of it
is callable from a session's Bash (or the `fleet_*` MCP tools).

**The lead's loop — look before you act.** Fleet state lives on disk (worktrees + a manifest of
what each was spun up for), not in the lead's head, so it *reads* the state instead of guessing —
which is what keeps a long-running or restarted lead from getting lost:

1. **`fleet-worktrees`** + **`fleet-inbox`** — what exists / what's free, and who needs you.
2. **Reuse a free worktree** before creating one — `fleet-spawn` refuses to proliferate (it lists
   the free ones) unless you `--reuse <wt>` or `--new`.
3. **`fleet-answer`** to unblock a stuck worker; **`fleet-pause`** to shed cost.

| goal | command |
|------|---------|
| every worktree + which are **FREE** | `fleet-worktrees` |
| live sessions + status | `fleet-list` |
| who needs you / what **finished** (drains since last look) | `fleet-inbox` |
| dispatch a self-contained brief | `fleet-send <session> "…"` |
| **ask** one and get the answer back | `fleet-send --reply-to me <session> "…"` |
| read a worker's last N messages | `fleet-read <session> [n]` |
| **reuse** a free worktree for a worker | `fleet-spawn <name> --reuse <wt> --prompt "…"` |
| **recycle** a worktree onto a fresh branch | `fleet-spawn <name> --reuse <wt> --branch <new> --from main` |
| new worktree (only if none free) | `fleet-spawn <name> [--branch b] [--from ref] --new --prompt "…"` |
| unblock a worker stuck on a dialog | `fleet-answer <session> "2"` |
| park / resume a worker (cost) | `fleet-pause <session>` · `fleet-resume <session>` |
| **rename** a worker + move its worktree | `fleet-rename <session> <new-name>` |
| **stop** a worker for good (or a dead orphan) | `fleet-stop <session>` |
| the checkout's **dev-stack slot** | `fleet-slot of <path>` · `fleet-slot list` |

### Dev-stack slots — one integer per checkout

Several checkouts of one repo each need their own local stack: an API port, a web port,
a database, a bucket. Picking those by hand per worktree is how two of them end up sharing
a database for a fortnight with nothing to notice.

`fleet-spawn` now hands every checkout one integer that **nothing else in the fleet
holds** — across every project *and* every profile — and puts it in the session's
environment as `CLAUDE_FLEET_SLOT`. Your repo derives the rest:

```bash
N=$(fleet-slot of "$PWD")       # 0 for the project's primary checkout
API_PORT=$((4000 + N))          # …and whatever else your stack needs
```

**ghostfleet allocates the number and nothing else.** It doesn't know what a port is,
which database you run, or what your stack is called — those formulas belong to the repo
that owns those names. That's what lets one allocator serve repos sharing no conventions.

**Slot 0 is the project's primary checkout** and is never allocated, so the checkout you
already work in keeps the ports it always had — adopting this changes nothing about a
machine that's already set up. "Primary" means the checkout the project is *registered*
at (the one `master` runs in), not "the first entry of `git worktree list`" — sibling
clones are each their own repo's first entry, and that test would hand `0` to all of them.

Claims are **idempotent by path**, so `--reuse` keeps its slot and therefore its
already-migrated database — which is what makes reuse cheaper than a fresh worktree
rather than merely tidier. `fleet-stop` releases; `fleet-clean` reclaims slots whose
checkout is gone by any route. `fleet-worktrees` shows the column.

**An empty answer is not zero.** `N=$(fleet-slot of "$PWD")` then `$((4000 + N))` yields
`4000` for a checkout nothing ever claimed — the primary's port, i.e. the exact silent
collision this removes, reintroduced at the commonest ad-hoc entry point (a plain `git
worktree add`). Boot scripts should call **`claim`**: it's idempotent, and it answers `0`
only for a registered primary.

**Pin the primary when the guess would be wrong.** `<root>/<name>`, else the first child
repo, else the root — fine for a project registered at its repo or at a container named
after it. It is wrong for a container holding several clones *and* unrelated products,
where the child-scan can hand slot 0 to a different product. Name it explicitly, one
`<project><TAB><path>` per line:

```
~/.config/ghostfleet/primaries
myrepo	/Users/me/work/myrepo
```

### `.ghostfleet/post-create` — the repo sets its own worktree up

A fresh worktree inherits no dependencies. ghostfleet symlinks the main checkout's
`node_modules` in, which is right for a single-package repo and **wrong for a pnpm
workspace**: the root `node_modules` links workspace packages by *relative* path, so a
symlinked tree resolves every workspace import from the symlink's real location — the
main checkout's source. Silent cross-tree contamination, and an install afterwards writes
straight through the symlink into that checkout.

So if a repo ships an executable `.ghostfleet/post-create`, `fleet-spawn` runs it in the
new worktree **instead of** symlinking (force it back with `CLAUDE_FLEET_LINK_NM=1`). It
runs after the slot is claimed, with `CLAUDE_FLEET_SLOT` and `CLAUDE_FLEET_WORKTREE` set,
so a hook can provision per-slot state as well as install. It is synchronous — the lead
waits — because the alternative is a worker whose first test run fails for a reason that
has nothing to do with its task. A failure is loud, not fatal.

The allocation is a directory of marker files (`~/.config/ghostfleet/slots/`) rather than
a table, because leads spawn concurrently and a read-modify-write over a shared free list
has nothing serialising it — two spawns would both take the lowest free number, which is
the collision this removes. There's no lock to reach for either (`flock(1)` isn't on
macOS), so creating the marker under `set -C` *is* the atom: it succeeds for exactly one
racer, and the directory listing is the free list.

```bash
fleet-worktrees                 # → "Free to reuse: api-3"
fleet-inbox                     # → api-1 DONE (feat/x) · api-2 NEEDS YOU: run tests?
fleet-answer api-2 "2"          # unblock the one waiting on a dialog
fleet-spawn fix-auth --reuse api-3 --branch feat/auth --from main \
  --prompt "Fix token refresh in src/auth/*. Done when auth tests pass."
fleet-read fix-auth 3           # check progress
```

The **inbox carries completion too**: a worker's turn ending shows as `DONE`, so
you learn when a brief is ready to review/merge without polling — and with
`CLAUDE_FLEET_NOTIFY_LEAD=1` the lead is **woken** on `done`/`need-you` (debounced)
so it acts hands-off instead of polling at all (see [Config](../README.md#config)). A fresh worktree
gets the main checkout's `node_modules` symlinked in (workers can run
lint/typecheck/tests; opt out with `CLAUDE_FLEET_LINK_NM=0`), and `--from` bases a
branch on your **local** ref — falling back to the remote tip only when local is
*behind* — so a worker never misses just-committed, unpushed work.

**Asking, not just dispatching.** A plain send is one-way: the target works, its turn ends, and
that `done` goes to **its own** fleet's master — so a question sent to another project looked
ignored no matter how long you waited. `--reply-to me` (MCP: `reply_to: true`) makes it a
conversation, and the answer comes back two ways:

```bash
fleet-send -s cf-getmycoi --reply-to me master "Does your /cois endpoint dedupe by externalId?"
# → arrives in your session as a message from getmycoi/master, even mid-turn
# …or, if it couldn't reach you, without polling:
fleet-inbox        # → 14:05  getmycoi/master  ANSWERED  yes — same externalId returns deduped:true…
fleet-read -s cf-getmycoi master 3      # the full reply
```

Every fleet session is **named `<project>/<session>`** for Claude Code's cross-session messaging
(`claude-here` passes `--name`; the derived default was `broker-agencies-61`, which nothing could
address), so the target is asked to answer you *directly* with `SendMessage`. That lands in your
session whatever you are doing — the case the relay below is worst at.

The **turn-end relay is the fallback**, and it's the reason `--reply-to` still leaves an address
next to the target: it covers an asker that isn't an addressable peer (a session started before
this, or renamed since), a **codex/opencode** target that has no such tool, and a turn that dies
before it gets there. The target is told to do both, so ending its turn is still an answer. Only
the turn your prompt actually starts answers (a prompt that queued behind a running turn doesn't
answer with that turn's work), a mid-request permission block reaches you too as `ASKS`, and one
request gets exactly one answer — a delivery the fleet can *prove* landed suppresses the row, so
you never read the same answer twice.

These are also exposed as **MCP tools** (`fleet_list` / `_send` / `_read` / `_spawn` /
`_worktrees` / `_inbox` / `_answer` / `_pause` / `_resume` / `_rename` / `_stop`) via a
dependency-free stdio server (`mcp/fleet-mcp.mjs`) that `install.sh` registers in each config dir.
The installed **`ghostfleet-orchestrate` skill** teaches a lead the loop above — reuse before
spawn, pull the inbox instead of polling every sibling, unblock with `fleet-answer`, mind the
shared budget — so you can just say *"work on a worktree to fix X"* and it reuses a free one. Each
session knows its fleet via `CLAUDE_FLEET_SOCK`; prompts must be self-contained (siblings don't
share your context). Another **project's** fleet is reachable too — `-s <socket>` from a shell, or
`project: "<name>"` on any of the MCP tools (`fleet_projects` lists the names). That includes
**starting a worker in another project**: `fleet_spawn` and `fleet_worktrees` are the two that
find the repo from the directory they run in rather than from a socket, so `project` puts them in
that project's checkout — the new worker lands on its fleet, on its branch, with its default
agent, without the lead needing to know where any of that lives.

**Budget.** One account funds the whole fleet, so wide fan-out drains it N× faster and everyone
stalls at the ceiling together. A **governor** (a dumb non-Claude loop, auto-started per fleet)
parks the newest workers as usage nears the ceiling and resumes them when the window resets; those
events show up in `fleet-inbox`. Opt out with `CLAUDE_FLEET_GOVERNOR=off`, watch-only with `=dry`.
