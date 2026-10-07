// The values the ghostfleet mod keeps in $.state, as `claude plugin validate` holds them.

/** What the lead's band draws (hooks/band.js): its team's counts and its PRs' checks. */
export type Band = {
  workers: number
  working: number
  need: number
  /** undefined: not read yet; null: gh could not say. */
  prs?: { green: number; red: number; pending: number } | null
}

/** What the ledger's row draws (hooks/ledger.js ledgerSummary), against `asOf`, a minute. */
export type LedgerItemRef = { id: string; text: string; at: number }
export type Ledger = {
  open: number
  promises: number
  oldest: LedgerItemRef | null
  oldestPromise: LedgerItemRef | null
  asOf: number
}

declare module 'claude-code' {
  interface PluginState {
    ghostfleet: { band: Band | null; ledger: Ledger | null }
  }
}
