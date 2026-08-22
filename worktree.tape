# ghostfleet worktree demo — a reproducible terminal GIF of the `w` flow.
#
#   brew install vhs                 # https://github.com/charmbracelet/vhs
#   env -u TMUX vhs worktree.tape    # writes docs/worktree-demo.mp4
#
# Then the README's GIF, which vhs will not produce at a size worth committing — the
# speed-up is what makes a 52-second walkthrough watchable in a README, and palettegen
# with stats_mode=diff is what stops a mostly-static dark terminal from banding:
#
#   ffmpeg -i docs/worktree-demo.mp4 -filter_complex \
#     "setpts=0.62*PTS,fps=12,scale=1000:-1:flags=lanczos,split[a][b];\
#      [a]palettegen=max_colors=128:stats_mode=diff[p];\
#      [b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 docs/worktree-demo.gif -y
#
# KEEP `env -u TMUX`. fleet-spawn prefers $TMUX over CLAUDE_FLEET_SOCK (deliberately —
# a --resume'd Claude can hold a stale env var), and vhs inherits the environment of
# whatever launched it, so recording from inside a fleet session hands the recorded shell
# YOUR socket. That used to spawn this tape's worker onto your fleet instead of the one
# on screen, and it did not look like a routing bug from the outside: the grid drew the
# new worktree as `· FREE — no session yet`, because the session was real and was simply
# on a socket that grid never reads.
#   The grid now passes `-s <its own socket>` to fleet-spawn, which beats $TMUX and is
# pinned past owner-routing, so the `w` flow this tape records is safe either way. The
# line stays because everything ELSE the recorded shell runs still reads $TMUX, and a
# recording is the one place where a wrong fleet is invisible until it is published.
#
# `Ctrl+S`, not `Ctrl+s` — vhs 0.11 rejects a lowercase char after a modifier, and the
# whole tape fails to parse rather than that one line being skipped.
#
# It records the `demo` PROFILE, whose projects are three throwaway repos under
# ~/gf-demo (see ~/.config/ghostfleet/projects.demo). That is deliberate: a recording of
# a real fleet publishes every project name and path on it.
#
# TWO ASSUMPTIONS TO RE-CHECK BEFORE RE-RECORDING:
#   * acme-api is the FIRST card, so it is already selected and this tape presses no
#     arrow to reach it. Reorder the projects file and Ctrl+S opens a different one.
#   * Ctrl+S (not a digit) opens the project's session GRID. A digit opens MASTER, and
#     every printable key after that goes into a live agent's prompt box — this tape
#     types `w`, a name and a branch, so getting that wrong dispatches junk to a worker.
#
# Name the worker after something other than its agent. opencode writes a marker file at
# $GIT_DIR/opencode, so a worker called `opencode` makes that name resolve as BOTH that
# file and refs/heads/opencode, and the NEXT create of it died on `fatal: invalid
# reference: opencode` — with the branch already made, so it half-succeeded. fleet-spawn
# now refuses that name up front and names the file, which is a clear message on camera
# rather than a wrecked repo, but it is still not the take you want to shoot.

Output docs/worktree-demo.mp4

Set Shell "zsh"
Set FontSize 16
Set Width 1400
Set Height 480
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Type "ghostfleet demo"
Enter
Sleep 6s

# the Projects screen: one card per project, live session counts on each.
# Ctrl+S opens the selected project's session GRID, skipping its master session.
Ctrl+S
Sleep 6s

# w = a brand-new worktree: a form, then git worktree add + a branch + a session
Type "w"
Sleep 2s
Type "spike"
Sleep 1s

# the branch does not have to match the name
Down
Type "feat/spike"
Sleep 1500ms

# `from` already reads main — down again to `agent`, right to pick opencode over claude
Down
Sleep 800ms
Down
Right
Sleep 2500ms

# create it: the worktree is cut, the agent boots, and it attaches you to the worker
Enter
Sleep 22s

# back out — the new worker is a card on the grid, and Projects counts one more session
Type "`"
Sleep 6s
Ctrl+P
Sleep 4s
