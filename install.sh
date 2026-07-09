#!/usr/bin/env bash
# claude-fleet installer.
# - symlinks bin/claude-fleet + bin/claude-here onto your PATH
# - wires hooks/fleet-event.sh into ~/.claude/settings.json (backing it up first)
# - links the example zellij layout if you use zellij
#
# Re-run any time; it's idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
BIN_DIR="${CLAUDE_FLEET_BIN:-$HOME/.local/bin}"
HOOK="$REPO/hooks/fleet-event.sh"

echo "claude-fleet installer"
echo "  repo:     $REPO"
echo "  bin dir:  $BIN_DIR"
echo "  settings: $SETTINGS"
echo

command -v jq   >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node is required (the v2 grid is a Node TUI)"; exit 1; }
command -v tmux >/dev/null 2>&1 || echo "! tmux not found — the grid needs it. Install: brew install tmux"

mkdir -p "$CLAUDE_DIR/fleet" "$BIN_DIR"
chmod +x "$REPO"/hooks/*.sh "$REPO"/bin/*

ln -sf "$REPO/bin/claude-fleet" "$BIN_DIR/claude-fleet"
ln -sf "$REPO/bin/claude-here"  "$BIN_DIR/claude-here"
echo "✓ linked claude-fleet, claude-here -> $BIN_DIR"

# --- wire hooks into settings.json ------------------------------------------
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
tmp="$(mktemp)"
jq --arg hook "$HOOK" '
  def entry: [ { matcher: "", hooks: [ { type: "command", command: $hook } ] } ];
  .hooks = ((.hooks // {}) + {
    Notification:     entry,
    Stop:             entry,
    UserPromptSubmit: entry,
    SessionStart:     entry,
    SessionEnd:       entry
  })
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "✓ wired hooks (Notification, Stop, UserPromptSubmit, SessionStart, SessionEnd)"
echo "  (previous settings backed up to $SETTINGS.bak.*)"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "! $BIN_DIR is not on your PATH. Add it:"
     echo "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

# --- optional: example zellij layout ----------------------------------------
if [ -d "$HOME/.config/zellij" ]; then
  ZL="$HOME/.config/zellij/layouts"
  mkdir -p "$ZL"
  ln -sf "$REPO/layouts/fleet.kdl" "$ZL/fleet.kdl"
  echo "✓ linked v2 layout -> $ZL/fleet.kdl  (launch: zellij --layout fleet attach -c <project>)"
  [ -e "$ZL/acme.kdl" ] || ln -sf "$REPO/layouts/acme.kdl" "$ZL/acme.kdl"
fi

echo
echo "Done. Launch a project's fleet with one pane:"
echo "    zellij --layout fleet attach -c acme     # then press 'n' to add a session"
echo "Or just run  claude-fleet  inside any zellij pane."
