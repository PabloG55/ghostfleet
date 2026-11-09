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

/** A pasted `[Image #N]` as PEEK read it (register.js peekLoad), or why it has no preview.
 *  Pixels for the cells stay in the module, never in $.state. */
export type PeekPicture = {
  label: string
  /** The file a window or a viewer opens: Claude Code's copy, or PEEK's from the prompt's bytes. */
  file?: string
  format?: string
  bytes?: number
  width?: number
  height?: number
  /** A PNG the terminal draws itself (kitty graphics): read by the terminal outside tmux on this
   *  machine, sent as its bytes (register.js peekPngs) through tmux or SSH. */
  png?: string
  /** The way it was read to be shown (peek-shape.js previewMode): a preview shown another way
   *  reads it again. */
  drawn?: 'window' | 'kitty' | 'cells'
  ready?: boolean
  /** Why it is words and not a picture (peek-shape.js WHY); `retry` when it may come yet. */
  why?: string
  retry?: boolean
}
/** The preview open now: paste `n`, opened by the chip `target` (`<requestId>/<chip key>`),
 *  as a card above the prompt or as a window of its own, shown the way `mode` says (decided as
 *  it opened: inside tmux, by the terminal looking). */
export type PeekShown = { n: number; target: string; edge: 'card' | 'window'; mode?: 'window' | 'kitty' | 'cells' }

/** The handoff DELIVERY submitted and has not seen start (register.js `.sent`): its id, and the
 *  ledger items its claim named and made, so the process a reload starts can stamp or undo them. */
export type DeliverySent = { id: string; ledgered: string[]; made: string[] }

declare module 'claude-code' {
  interface PluginState {
    ghostfleet: {
      band: Band | null; ledger: Ledger | null
      deliverySent: DeliverySent | null
      /** PEEK: the switch; the draft's `[Image #N]` numbers; each paste read, by N; the preview open. */
      peekOn: boolean; peekDraft: number[]; peekPics: Record<string, PeekPicture>; peekShown: PeekShown | null
    }
  }
}
