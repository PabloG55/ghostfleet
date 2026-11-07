// The values the ghostfleet mod keeps in $.state, as `claude plugin validate` holds them.

/** What the lead's band draws (hooks/band.js): its team's counts and its PRs' checks. */
export type Band = {
  workers: number
  working: number
  need: number
  /** undefined: not read yet; null: gh could not say. */
  prs?: { green: number; red: number; pending: number } | null
  /** A wake the fleet is holding because this session's input box never read empty
   *  (band-shape.js heldWake): since when (epoch s), why, drawn against `asOf`, a minute. */
  held?: { since: number; why: 'typed' | 'nobox'; asOf: number } | null
}

/** What the ledger's row draws (hooks/ledger.js ledgerSummary), against `asOf`, a minute. */
export type LedgerItemRef = { id: string; text: string; at: number }
export type Ledger = {
  open: number
  promises: number
  oldest: LedgerItemRef | null
  oldestPromise: LedgerItemRef | null
  /** Why the judge's last call failed open; null while it is working. */
  judgeFailing: string | null
  asOf: number
}

/** One picture the session showed (hooks/peek-shape.js picturesIn), as PEEK draws it. */
export type PeekPicture = {
  key: string
  kind: 'paste' | 'file'
  label: string
  /** The N of `[Image #N]`, for a paste. */
  n?: number
  /** The resolved absolute path, for a file. */
  path?: string
  caption: string
  /** Decoded and ready to draw; the pixels stay in the module, never in $.state. */
  ready: boolean
  /** Why it is words and not a picture (peek-shape.js WHY). */
  why?: string
}
/** PEEK's pane and chips: the session's pictures, oldest first, and the one picked
 *  (null follows the newest). `gen` moves when a picture is decoded, to redraw. */
export type Peek = { pictures: PeekPicture[]; selected: string | null; gen: number }

declare module 'claude-code' {
  interface PluginState {
    ghostfleet: { band: Band | null; ledger: Ledger | null; peek: Peek | null; peekOn: boolean }
  }
}
