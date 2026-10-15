# lib/undim.awk — a pane captured WITH attributes (capture-pane -e), as plain text with
# every DIM run removed. Run it, do not paste it: `awk -f lib/undim.awk`, under LC_ALL=C.
#
# A SUGGESTION IS NOT TYPING. The agent fills an EMPTY composer with greyed text — `Try "…"`
# in a fresh session, a suggested next prompt after a turn — and a plain capture drops the
# attribute, so it reads exactly like something a person typed. Two readers were fooled by
# it: hibernation vetoed every idle session as holding a draft, and the wake guard
# (hooks/fleet-event.sh _input_state) read an idle lead's box as occupied and never woke it.
# Measured on live panes and on a fresh scratch session alike: the glyph, a no-break space,
# then `ESC[2m … ESC[0m` — SGR 2 and nothing else. A person's typing is never dim.
#
# The SGR parameters are WALKED rather than grepped for a 2: `38;5;2` is a colour index, not
# dim, and a pattern would read one as the other and eat coloured text. Every other escape
# (colours, OSC hyperlinks) is then dropped, so a caller sees the same plain text a
# `capture-pane -p` would have given it, minus the dim runs.
#
# LC_ALL=C because a capture can hold a byte that is not valid UTF-8 (a spinner glyph split
# across a redraw), and BSD awk in a UTF-8 locale aborts the record on one. The escapes are
# all ASCII, so byte-wise index/substr lose nothing.
function sgr(params,   n, P, i) {
  n = split(params, P, ";"); if (n == 0) { dim = 0; return }
  for (i = 1; i <= n; i++) {
    if (P[i] == "38" || P[i] == "48" || P[i] == "58") { i += (P[i+1] == "2") ? 4 : 2; continue }
    if (P[i] == "" || P[i] == "0" || P[i] == "22") dim = 0
    else if (P[i] == "2") dim = 1
  }
}
{ line = $0; out = ""
  while ((k = index(line, "\033")) > 0) {
    if (!dim) out = out substr(line, 1, k - 1)
    line = substr(line, k)
    if (match(line, /^\033\[[0-9;?]*[ -\/]*[@-~]/)) {
      seq = substr(line, 1, RLENGTH); line = substr(line, RLENGTH + 1)
      if (substr(seq, length(seq)) == "m") sgr(substr(seq, 3, length(seq) - 3))
    } else if (match(line, /^\033\][^\007\033]*(\007|\033\\)/)) {   # OSC, a hyperlink
      line = substr(line, RLENGTH + 1)
    } else line = substr(line, 2)
  }
  if (!dim) out = out line
  print out }
