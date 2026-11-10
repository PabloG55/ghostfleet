// Only an authorization this session started may open a loopback replay surface.
// No callback URL passes through the model, ledger, knowledge or notification paths.
export const LOGIN_TTL = 600_000
export const CONNECTORS = 'https://claude.ai/settings/connectors'
export function pendingLogin(input, identity, now = Date.now()) {
  const match = /^mcp__(.+)__authenticate$/.exec(input.tool_name || '')
  if (!match || !identity.sock || !identity.session || !identity.session_id || !identity.project) return null
  const server = match[1]
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(server)) return null
  const base = { ...identity, server, created: now, expires: now + LOGIN_TTL, used: false }
  if (server.startsWith('claude_ai_'))
    return { ...base, kind: 'connector', connector: server.slice(10), provider: 'claude.ai', authorize: CONNECTORS }
  const text = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response || '')
  for (const candidate of text.match(/https?:\/\/[^\s<>"\\]+/g) || []) {
    try {
      const authorize = new URL(candidate)
      const redirect = new URL(authorize.searchParams.get('redirect_uri'))
      const state = authorize.searchParams.get('state')
      if (authorize.protocol !== 'https:' || authorize.username || authorize.password || authorize.searchParams.has('code')
        || redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)
        || redirect.username || redirect.password || !redirect.port || Number(redirect.port) < 1 || redirect.hash || redirect.search || !state) continue
      return { ...base, kind: 'loopback', provider: authorize.hostname, authorize: authorize.href,
        port: Number(redirect.port), path: redirect.pathname, state }
    } catch {}
  }
  return null
}
