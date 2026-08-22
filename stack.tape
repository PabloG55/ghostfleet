# ghostfleet stack demo — three agents on screen at once, one pane each.
#
#   brew install vhs               # https://github.com/charmbracelet/vhs
#   env -u TMUX vhs stack.tape     # writes docs/stack-demo.mp4
#   # then the GIF, as in worktree.tape's header
#
# `env -u TMUX` for the same reason worktree.tape needs it: fleet-spawn prefers $TMUX
# over CLAUDE_FLEET_SOCK (bin/fleet-spawn:56), and vhs inherits the environment of
# whatever launched it. Recording from inside a fleet would aim this at YOUR fleet.
#
# It records the `demo` profile (three throwaway repos under ~/gf-demo), because the
# stack screen lists every live session in every project of the profile — on a real
# fleet that frame is a directory of everything you are working on.
#
# WHAT THE DEMO FLEET HAS TO CONTAIN, since the point is three DIFFERENT agents:
#
#   fleet-spawn api-fix   --new --agent claude
#   fleet-spawn docs-pass --new --agent opencode
#   fleet-spawn types     --new --agent codex
#
# All three must already be at their prompts, or the panes record a first-run dialog
# instead of an agent. Each one has its own, and each is per-config-dir, so a fresh
# profile hits all of them:
#   claude   — the trust-this-folder prompt, THEN the bypass-permissions warning
#              (agent-here passes --dangerously-skip-permissions, so it always asks)
#   codex    — an "Update available" prompt that blocks the UI until answered; pick
#              "Skip until next version" so a re-record does not hit it again
#   opencode — none, but with no provider connected it says so on the splash
#
# And `claude` needs the profile's OWN login: CLAUDE_CONFIG_DIR=~/.claude-demo claude,
# then /login. Credentials are per config dir, so being logged in at the desk is not
# enough and the pane will just read "Not logged in · Please run /login".

Output docs/stack-demo.mp4

Set Shell "zsh"
Set FontSize 13
Set Width 1800
Set Height 800
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Type "ghostfleet demo"
Enter
Sleep 6s

# Ctrl+S opens the selected project's session grid, skipping master
Ctrl+S
Sleep 5s

# t = the stack screen: every live session in every project of this profile
Type "t"
Sleep 3s

# space marks a member — these three run claude, opencode and codex
Space
Sleep 700ms
Down
Space
Sleep 700ms
Down
Space
Sleep 2s

# enter opens the stack: one pane per member, split evenly, each keeping its own
# status bar, with the pane border carrying `project · session`
Enter
Sleep 16s

# backtick leaves the whole stack in one press
Type "`"
Sleep 4s
