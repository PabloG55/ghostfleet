// The values the ghostfleet mod keeps in $.state, as `claude plugin validate` holds them.

/** What the lead's band draws (hooks/band.js): its team's counts and its PRs' checks. */
export type Band = {
  workers: number
  working: number
  need: number
  /** undefined: not read yet; null: gh could not say. */
  prs?: { green: number; red: number; pending: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    ghostfleet: { band: Band | null }
  }
}
