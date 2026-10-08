#!/usr/bin/env bash
# ghostfleet — Jarvis's confirm-list, in front of its Bash tool.
#
# Wired by `fleet-jarvis init` into JARVIS'S OWN project settings (.claude/settings.json in
# its home), not into the global ones: this question is only ever asked about one session,
# and a global PreToolUse on Bash would spawn this for every command every session runs.
#
# The MCP tools are gated inside mcp/fleet-dispatch.mjs; this is the other door. A merge or
# a push is a shell command — there is no MCP tool for either — so a contract enforced only
# at the MCP layer would leave the two actions the owner named first wide open to Bash.
#
# Blocking contract: exit 2 with the reason on stderr, which Claude Code hands back to the
# session. Everything that is not a decision — a missing jq, an unreadable payload, a
# session that is not Jarvis's master — exits 0: a guard that breaks the session it guards
# is worse than the thing it guards against.
command -v jq >/dev/null 2>&1 || exit 0
MARK="${CLAUDE_FLEET_JARVIS_DIR:-$HOME/.config/ghostfleet}/jarvis"
[ -f "$MARK" ] || exit 0
# Switched off is no Jarvis, so nothing to guard — the same direction as no marker.
grep -qsx off "$MARK.enabled" && exit 0
input="$(cat)"
[ "$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)" = Bash ] || exit 0

# ONLY THE MASTER ON JARVIS'S SOCKET. From the live $TMUX, the same drift-proof source the
# event hook uses, and the session NAME from tmux itself rather than from an env var that a
# resumed session can carry stale.
jsock="$(grep -m1 '^sock=' "$MARK" 2>/dev/null | cut -d= -f2-)"
_t="${TMUX:-}"; sock="${_t%%,*}"; sock="${sock##*/}"
[ -n "$jsock" ] && [ "$sock" = "$jsock" ] || exit 0
sess="$(tmux -L "$sock" display-message -p -t "${TMUX_PANE:-}" '#{session_name}' 2>/dev/null)"
[ "$sess" = master ] || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null \
  | "$HOOK_DIR/../bin/fleet-jarvis" gate-bash
rc=$?
# 2 is a decision; anything else (node missing, a crash) is not one and must not block.
[ "$rc" = 2 ] && exit 2
exit 0
