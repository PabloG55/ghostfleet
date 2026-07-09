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

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)"; exit 1; }

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
  if [ ! -e "$ZL/acme.kdl" ]; then
    ln -sf "$REPO/layouts/acme.kdl" "$ZL/acme.kdl"
    echo "✓ linked example layout -> $ZL/acme.kdl (edit its cwd paths)"
  else
    echo "· $ZL/acme.kdl already exists — left it alone"
  fi
fi

echo
echo "Done. Start (or restart) a Claude Code session, then run:  claude-fleet"
if command -v zellij >/dev/null 2>&1; then
  echo "Tip: to auto-resume hand-started claude panes on zellij re-attach, run:"
  echo "    $REPO/scripts/enable-zellij-resume.sh"
fi
