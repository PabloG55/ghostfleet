# ghostfleet demo — a reproducible terminal GIF.
#
#   brew install vhs        # https://github.com/charmbracelet/vhs
#   vhs demo.tape           # writes docs/demo.gif
#
# Re-record whenever the UI changes: that's the point of scripting it rather than
# screen-capturing by hand. It drives the REAL tool, so whatever your fleet looks
# like is what gets recorded — have 2-3 sessions running first so the grid isn't empty.

Output docs/demo.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1400
Set Height 800
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# --- the pitch: one command, every project ---------------------------------
Type "ghostfleet"
Enter
Sleep 3s

# the Projects screen: one card per project, live status on each
Sleep 2s

# insta-jump: digit opens a project, no arrowing
Type "2"
Sleep 4s

# from master, C-s drops into that project's session grid
Ctrl+s
Sleep 3s

# the grid: a card per agent — status, branch, last thing it said
Sleep 2s

# jump straight into the 2nd agent and watch it work
Type "2"
Sleep 4s

# ` steps back out — the session keeps running in the background
Type "`"
Sleep 2s

# ^F jumps anywhere: project 1, session 1, from any screen
Ctrl+f
Sleep 1s
Type "1"
Sleep 1s
Type "1"
Sleep 4s

# back out to the grid, then up to Projects with ^P
Type "`"
Sleep 2s
Ctrl+p
Sleep 3s
