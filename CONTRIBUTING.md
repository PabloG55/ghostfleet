# Contributing

Short version: **bugs are very welcome, features are often declined, and a test that
cannot fail does not count.**

## What this project is, so the rest makes sense

ghostfleet is one person's daily driver that happens to be public. It is not staffed, it
has no roadmap, and there is no SLA on anything here. I answer issues when I answer them.
Saying that plainly up front is meant to be useful to you: it tells you what a slow reply
means, and it tells you not to wait on me before forking.

MIT means you can take it anywhere, and you do not need my permission or my attention to
do that.

## Bugs

**Please file them, especially on Linux and WSL2.** I develop on macOS, and the class of
bug I cannot find alone is the environmental one — a different tmux, a different coreutils,
a different shell. The single worst offender so far: tmux **≤ 3.5** pushes command output
through `vis(3)`, so the `\x1f` byte this code uses as a field separator comes back as the
four literal characters `\037`, records stop splitting, and the whole row lands in the
first field. Homebrew ships 3.7b and Ubuntu 24.04 ships 3.4, so the identical code looks
"broken on Linux" and is nothing of the kind.

That is why the issue form asks for `tmux -V` before it asks what went wrong.

**Before you paste output:** the Projects screen is your entire project list, and a
screenshot of it publishes every client name on your machine. Read what you paste.

## Features

They get declined more often than accepted, and that is not a verdict on the idea. Every
option here has to keep working across four agents, three platforms and several tmux
versions, and that maintenance budget is already spent. The feature-request form lists what
tends to get through; the honest summary is that fixes and environment support are easy
yeses and new surface area is usually a no.

If you would rather not write it up for a likely no, open a short issue asking first. That
is a completely reasonable thing to do and I will not think less of the idea for it.

## Pull requests

Run the suite first:

```bash
./test/run.sh          # no dependencies, a couple of seconds
```

Then three things that are unusual enough to state:

**1. A test that can only pass proves nothing.** Every detector assertion in this repo runs
in both directions on purpose — a busy-pane regex is only proven by matching a real busy
pane *and* staying silent on a real idle one. When you add a test, break the code
deliberately and watch it go red before you trust it. If you cannot make it fail, it is not
testing what you think.

**2. Write the commit message about the failure, not the diff.** The diff already shows
what changed. What is worth keeping is what the wrong behaviour was, why it happened, and
why the fix is shaped this way. Most of this history is reliability fixes where the cause
was non-obvious, and that reasoning is the valuable part. Look at `git log` before writing
yours — the house style is obvious once you see a few.

**3. Interactive parts need real verification.** The suite cannot cover the TUI. Drive it
in a scratch tmux pane and send it keys; `node --check` proves syntax, not that a keystroke
does not kill the grid pane. Say in the PR what you actually ran.

`CLAUDE.md` at the repo root is the working notes — it is written for coding agents, but it
is also the most direct list of what has bitten people here and is worth a read before
changing anything load-bearing.

## Security

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting instead — the **Report a vulnerability** button under this repository's *Security*
tab — which opens a private thread with the maintainer and gives me a chance to fix it before
it is public.

No address is published here on purpose: an email in a public file is scraped, and this one
used to be a work address, which told a reader more about where the project lives than the
security process needed them to know.
