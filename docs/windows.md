# Running ghostfleet on Windows

Native Windows isn't supported: sessions are tmux servers, and tmux is POSIX-only. On
Windows, ghostfleet runs inside **WSL2**, where it is ordinary Linux. This page is the
whole path from a Windows machine with nothing on it to a fleet you can open, and after
the WSL part it is one command.

## 1. WSL2 and a Linux distro (PowerShell)

```powershell
wsl --install -d Ubuntu
```

If the first launch fails with `Wsl/Service/E_UNEXPECTED`, the WSL platform itself is
out of date — `wsl --update`, then launch Ubuntu again.

The first launch asks for a Linux username and password. **Don't skip that step and
run everything as `root`** (`--no-launch` skips it): the fleet's config, runtime and
Claude sign-in all live in your home directory, and a root install puts them in `/root`.
If you already have a root-only distro, make a user and set it as the default:

```bash
useradd -m -s /bin/bash -G sudo <you>
passwd <you>
printf '[user]\ndefault=<you>\n' > /etc/wsl.conf
```

then `wsl --terminate Ubuntu` from PowerShell, and reopen it.

## 2. The two things the installer needs to already be there (inside WSL)

```bash
sudo apt-get update
sudo apt-get install -y git curl nodejs npm
```

`node` 18 or newer. Everything else — `tmux`, `jq`, Claude Code, and Neovim + LazyVim
for the `Ctrl-n` editor tab — the installer offers to install for you.

## 3. Install

```bash
cd ~
npx ghostfleet-cli
```

It asks before each missing piece (`[Y/n]`, Enter means yes). To take all of them without
being asked, put `--yes` **after** the package name — before it, npx eats it:

```bash
npx ghostfleet-cli --yes
```

What each offer does:

| piece | how it is installed | why |
|---|---|---|
| `tmux`, `jq` | `sudo apt-get install` | a session **is** a tmux server; the hook wiring is written with jq |
| Claude Code | the native installer (`curl -fsSL https://claude.ai/install.sh \| bash`), into `~/.local/bin` | the default agent. No `sudo`, unlike `npm install -g` on a stock Linux node |
| Neovim | the official release tarball, under `~/.local` | `Ctrl-n` opens an editor on a session's folder. Ubuntu 24.04's apt Neovim (0.9) is too old for LazyVim |
| LazyVim | the LazyVim starter, into `~/.config/nvim` | **only** when there is no `~/.config/nvim` yet — an existing config is never touched |

Skip any of them and the install still finishes; `Ctrl-n` without an editor tells you
what is missing. To use another editor instead: `export CLAUDE_FLEET_EDITOR=hx`.

**Run it from `~`, not from inside a clone of this repo.** In a directory whose
`package.json` declares a `ghostfleet` bin, `npm exec` decides the package is already
installed and never stages it — `sh: 1: ghostfleet: not found`.

If the installer says `~/.local/bin` is not on your PATH (it suggests `~/.zshrc`; Ubuntu's
shell is bash):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Then sign in to Claude once: run `claude` on its own and follow the prompt.

## 4. Your projects

Keep repos on **WSL's own filesystem** (`~/projects/…`), not under `/mnt/c/…`: git and
node are several times slower across that boundary, and a checkout of this repo there is
what triggers the `npm exec` trap above.

```bash
ghostfleet
```

The first screen walks you through adding a project. Press `c` there (or on the
`+ add project` card later) to **clone a repo straight into it** — a URL, or
`owner/repo` for GitHub; with `gh` signed in, private repos work too. It lands in
`~/projects/<repo>` unless you browse somewhere else first. Already cloned? `⏎` browses
to the folder instead. Then `n` starts a session.

## 5. Opening PRs from WSL (optional)

The fleet cuts branches for you; pushing and opening a PR needs git to know who you are
and GitHub to know it is you:

```bash
sudo apt-get install -y gh
gh auth login --git-protocol https --web
gh auth setup-git
git config --global user.name  "<your name>"
git config --global user.email "<your GitHub email>"
```

## Notes

- Use a real terminal window (Windows Terminal with the Ubuntu profile). `ghostfleet` is a
  full-screen TUI; run through a piped, non-tty `wsl.exe -- …` it waits for a screen that
  never comes.
- `Ctrl-n` / `Ctrl-t` are taken by the fleet inside a session (editor / terminal tab), so
  inside Claude they no longer reach Claude. `Ctrl-a n` / `Ctrl-a t` do the same.
