#!/usr/bin/env bash
# Enable zellij auto-resume for ad-hoc `claude` panes.
#
# The claude-fleet layout already resumes each tab (it runs `claude-here`). This
# covers the OTHER case: panes you start by hand (open a tab, type `claude`).
# It turns on zellij session serialization and installs a post_command_discovery_hook
# that rewrites a resurrected bare `claude` into `claude --continue`, so on
# resurrection the pane reopens its most recent conversation in its original cwd
# instead of a blank session.
#
# Idempotent. Backs up your config first. Only touches two top-level directives.
set -euo pipefail

CFG="${ZELLIJ_CONFIG:-$HOME/.config/zellij/config.kdl}"
MARK="// claude-fleet:auto-resume"

[ -f "$CFG" ] || { echo "error: no zellij config at $CFG"; exit 1; }

if grep -qF "$MARK" "$CFG"; then
  echo "· already enabled ($MARK present in $CFG) — nothing to do"
  exit 0
fi

# Don't clobber a hook the user already wrote.
if grep -qE '^[[:space:]]*post_command_discovery_hook[[:space:]]' "$CFG"; then
  echo "! $CFG already defines post_command_discovery_hook — leaving it untouched." >&2
  echo "  Add 'session_serialization true' and a 'claude' -> 'claude --continue' rewrite yourself." >&2
  exit 1
fi

cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"

need_ser=1
grep -qE '^[[:space:]]*session_serialization[[:space:]]' "$CFG" && need_ser=0

{
  echo ""
  echo "$MARK — resume conversations when zellij resurrects a session"
  echo "// Layout panes use claude-here; this covers panes you started by hand."
  [ "$need_ser" = 1 ] && echo "session_serialization true"
  cat <<'KDL'
post_command_discovery_hook "echo $RESURRECT_COMMAND | sed 's/^claude$/claude --continue/'"
KDL
} >> "$CFG"

echo "✓ appended auto-resume settings to $CFG (backup saved alongside)"
[ "$need_ser" = 0 ] && echo "  (session_serialization was already set — left it as-is)"

if command -v zellij >/dev/null 2>&1; then
  if zellij setup --check >/dev/null 2>&1; then
    echo "✓ zellij config still parses"
  else
    echo "! zellij setup --check reported issues — review $CFG (restore from the .bak if needed)" >&2
  fi
fi
echo "Restart zellij (or start a new session) for serialization to take effect."
