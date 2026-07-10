#!/usr/bin/env bash
# claude-fleet installer.
# - symlinks bin/claude-fleet + bin/claude-here onto your PATH
# - wires hooks/fleet-event.sh into ~/.claude/settings.json (backing it up first)
# - links the example zellij layout if you use zellij
#
# Re-run any time; it's idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${CLAUDE_FLEET_BIN:-$HOME/.local/bin}"
HOOK="$REPO/hooks/fleet-event.sh"

echo "claude-fleet installer"
echo "  repo:     $REPO"
echo "  bin dir:  $BIN_DIR"
echo

command -v jq   >/dev/null 2>&1 || { echo "error: jq is required (brew install jq)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node is required (the v2 grid is a Node TUI)"; exit 1; }
command -v tmux >/dev/null 2>&1 || echo "! tmux not found — the grid needs it. Install: brew install tmux"

mkdir -p "$BIN_DIR"
chmod +x "$REPO"/hooks/*.sh "$REPO"/bin/*

for b in claude-fleet claude-here fleet-schedule fleet-send fleet-list fleet-read fleet-spawn fleet-jump fleet-pause fleet-resume fleet-governor; do
  ln -sf "$REPO/bin/$b" "$BIN_DIR/$b"
done
echo "✓ linked claude-fleet + helpers (here, schedule, send, list, read, spawn, jump, pause, resume, governor) -> $BIN_DIR"

# --- wire hooks into every Claude config dir (profile) ----------------------
# Each profile (work=~/.claude, personal=~/.claude-personal, …) has its OWN
# settings.json, so the status/notification hooks must be wired into each.
wire_hooks() {
  local dir="$1" settings="$1/settings.json" tmp
  mkdir -p "$dir/fleet" "$dir/skills"
  # orchestration skill so a lead session knows it can drive siblings
  ln -sf "$REPO/skill/claude-fleet-orchestrate" "$dir/skills/claude-fleet-orchestrate"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp "$settings" "$settings.bak.$(date +%Y%m%d%H%M%S)"
  tmp="$(mktemp)"
  jq --arg hook "$HOOK" --arg mcp "$REPO/mcp/fleet-mcp.mjs" '
    def entry: [ { matcher: "", hooks: [ { type: "command", command: $hook } ] } ];
    .hooks = ((.hooks // {}) + {
      Notification: entry, Stop: entry, UserPromptSubmit: entry,
      SessionStart: entry, SessionEnd: entry })
    | .mcpServers = ((.mcpServers // {}) + { "claude-fleet": { command: "node", args: [$mcp] } })
  ' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "✓ wired hooks + fleet MCP into $settings (backup saved)"
}
is_config_dir() { [ -f "$1/settings.json" ] || [ -d "$1/projects" ] || [ -f "$1/.claude.json" ]; }

wire_hooks "$HOME/.claude"                       # work (default)
for d in "$HOME"/.claude-*; do                   # personal + any other profiles
  [ -d "$d" ] && is_config_dir "$d" && wire_hooks "$d"
done

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
  echo "✓ linked layout -> $ZL/fleet.kdl  (launch: zellij --layout fleet attach -c fleet)"
fi

echo
echo "Done. In a zellij pane:"
echo "    claude-fleet            # work profile   (~/.claude)"
echo "    claude-fleet personal   # personal       (~/.claude-personal)"
echo "Then press 'n' to add a session. (Layout: zellij --layout fleet attach -c <project>.)"
