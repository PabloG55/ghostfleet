// Account errors are engine UI, not mentions of /login in an assistant's prose.
// Join soft wraps within a UI block so narrow terminals keep the same answer.
export function accountLoginReason(pane) {
  const text = String(pane).replace(/\x1b\[[0-9;]*m/g, '');
  if (/^\s*Paste code here(?: if prompted)? >\s*$/m.test(text)) return 'Claude account sign-in';
  for (const block of [...text.split('\n'), ...text.split(/\n\s*\n/)]) {
    const line = block.replace(/(\S)\n(?=\S)/g, '$1').replace(/\n\s*/g, ' ').trim();
    if (/^(?:(?:⎿|API Error:)\s*)?(?:API Error:\s*401\s*[·:]\s*)?(?:Not logged in|OAuth token (?:revoked|has expired)|Login expired|Invalid API key)\s*·\s*Please run \/login(?:\s|$)/i.test(line)
      || /^(?:⎿\s*)?(?:API Error:\s*401\s*[·:]\s*)?(?:OAuth token has expired|OAuth refresh token is no longer valid).*Please run \/login/i.test(line)
      || /^Authentication required\s*·\s*Sign in again to continue\s*$/.test(line)) return 'Claude account sign-in';
  }
  return null;
}

export function accountLoginPrompt(pane) {
  return /^\s*Paste code here(?: if prompted)? >\s*$/m.test(String(pane));
}

// tmux -J rejoins only soft wraps; URL extraction never accepts another origin.
export function accountLoginURL(pane) {
  if (!accountLoginPrompt(pane)) return null;
  const raw = String(pane).match(/^https:\/\/\S+/m)?.[0];
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash
      || !['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(u.hostname)
      || !['/cai/oauth/authorize', '/oauth/authorize'].includes(u.pathname)
      || !u.searchParams.get('state') || !u.searchParams.get('code_challenge')) return null;
    return u.href;
  } catch { return null; }
}
