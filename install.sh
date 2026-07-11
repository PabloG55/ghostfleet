#!/usr/bin/env bash
# claude-fleet installer.
# - symlinks bin/claude-fleet + bin/claude-here onto your PATH
# - wires hooks/fleet-event.sh into ~/.claude/settings.json (backing it up first)
# - registers the fleet MCP server into <config>/.claude.json (via `claude mcp add`;
#   Claude does NOT read MCP from settings.json)
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

for b in claude-fleet claude-here fleet-schedule fleet-send fleet-list fleet-read fleet-spawn fleet-jump fleet-pause fleet-resume fleet-governor fleet-statusbar fleet-worktrees fleet-answer fleet-inbox; do
  ln -sf "$REPO/bin/$b" "$BIN_DIR/$b"
done
echo "✓ linked claude-fleet + helpers (here, schedule, send, list, read, spawn, jump, pause, resume, governor, statusbar, worktrees, answer, inbox) -> $BIN_DIR"

# --- wire hooks into every Claude config dir (profile) ----------------------
# Each profile (work=~/.claude, personal=~/.claude-personal, …) has its OWN
# settings.json, so the status/notification hooks must be wired into each.
# Register the fleet MCP server where Claude ACTUALLY reads it. Claude Code does
# NOT read mcpServers from settings.json — only from .claude.json (user/local
# scope) or .mcp.json (project). With CLAUDE_CONFIG_DIR set, the user-scoped file
# is $CLAUDE_CONFIG_DIR/.claude.json. `claude mcp add` (run with the same
# CLAUDE_CONFIG_DIR) writes to the exact file the fleet's sessions read, so the
# fleet_* tools surface in every session (incl. --resume + --dangerously-skip).
register_mcp() {
  local dir="$1" mcp="$REPO/mcp/fleet-mcp.mjs"
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_CONFIG_DIR="$dir" claude mcp remove -s user claude-fleet >/dev/null 2>&1 || true
    if CLAUDE_CONFIG_DIR="$dir" claude mcp add -s user --transport stdio claude-fleet -- node "$mcp" >/dev/null 2>&1; then
      echo "✓ registered claude-fleet MCP (user scope) -> $dir/.claude.json"
    else
      echo "! could not 'claude mcp add' in $dir — run: CLAUDE_CONFIG_DIR=$dir claude mcp add -s user --transport stdio claude-fleet -- node $mcp"
    fi
  else
    # no claude CLI on PATH — write the top-level mcpServers into .claude.json directly
    local cj="$dir/.claude.json" t; [ -f "$cj" ] || echo '{}' > "$cj"; t="$(mktemp)"
    if jq --arg m "$mcp" '.mcpServers = ((.mcpServers // {}) + { "claude-fleet": { type:"stdio", command:"node", args:[$m], env:{} } })' "$cj" > "$t" 2>/dev/null; then
      mv "$t" "$cj"; echo "✓ wrote claude-fleet MCP -> $cj"
    else rm -f "$t"; echo "! failed to write MCP into $cj"; fi
  fi
}

wire_hooks() {
  local dir="$1" settings="$1/settings.json" tmp
  mkdir -p "$dir/fleet" "$dir/skills"
  # orchestration skill so a lead session knows it can drive siblings
  ln -sf "$REPO/skill/claude-fleet-orchestrate" "$dir/skills/claude-fleet-orchestrate"
  [ -f "$settings" ] || echo '{}' > "$settings"
  cp "$settings" "$settings.bak.$(date +%Y%m%d%H%M%S)"
  tmp="$(mktemp)"
  # Hooks belong in settings.json; MCP does NOT (see register_mcp). Wire the hooks
  # and strip any stale claude-fleet MCP entry an older installer wrote here.
  jq --arg hook "$HOOK" '
    def entry: [ { matcher: "", hooks: [ { type: "command", command: $hook } ] } ];
    .hooks = ((.hooks // {}) + {
      Notification: entry, Stop: entry, UserPromptSubmit: entry,
      SessionStart: entry, SessionEnd: entry })
    | (if .mcpServers then .mcpServers |= del(.["claude-fleet"]) else . end)
    | (if (.mcpServers // {}) == {} then del(.mcpServers) else . end)
  ' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "✓ wired hooks into $settings (backup saved)"
  register_mcp "$dir"
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
