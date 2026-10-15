// Replays test/fixtures/ledger-replay.json through a ledger.js and prints what the ledger holds
// at the end: a count per source and state, the nudge items, the items resent after a stop,
// and the promise whose work landed after it went stale. The judge is the fixture's: each
// turn's `verdict` is [text to match, status, reason] for the items the code shows the judge
// (open ones, and with the fix the dormant ones the turn mentions). Every turn not otherwise
// judged answers "open" for what it was shown, as a judge does for a turn that ignores an item.
//   node ledger-replay.mjs <ledger.js> <fixture.json>
// Run it against an older ledger.js to see the defects it reproduces.
import fs from 'node:fs'
const [js, fixture] = process.argv.slice(2)
const L = await import(js)
const { events, nudge } = JSON.parse(fs.readFileSync(fixture, 'utf8'))
const T0 = 1_800_000_000_000
let l = L.emptyLedger()
let choice = ''
const set = n => { if (n) l = n }
for (const e of events) {
  const at = T0 + e.t * 1000
  if (e.prompt || e.fleet || e.nudge) {
    const text = e.prompt || e.fleet || nudge
    const source = e.prompt ? 'user' : 'fleet'
    // A nudge with no handoff marker: the paste fallback, or an older fleet-send. The old
    // code recorded it as typed (sourceOf let it through); the fix refuses it by its words.
    const ids = []
    set(L.addPrompt(l, { text, at, source, whole: source === 'fleet', choiceTurn: choice }, ids))
    set(L.stampTurn(l, text, e.turn))
    if (ids.length) l = { ...l, items: l.items.map(i => (ids.includes(i.id) && !i.turnId ? { ...i, turnId: e.turn } : i)) }
  } else if (e.abort) {
    set(L.markInterrupted(l, e.abort, at))
    choice = ''
  } else if (e.answer !== undefined) {
    if (L.expireDormant) set(L.expireDormant(l, at))
    const open = L.openItems(l, at)
    const back = L.revisit ? L.revisit(l, at, e.answer) : []
    const shown = [...open, ...back]
    const rules = e.verdict || []
    const items = shown.map(i => {
      const r = rules.find(([m]) => i.text.includes(m))
      return { id: i.id, status: r ? r[1] : 'open', reason: r ? r[2] : 'not mentioned' }
    })
    const promises = (e.promises || []).map(text => ({ text }))
    set(L.applyVerdict(l, { items, promises, waitingOnPerson: false }, { nowMs: at, turnId: e.turn, promises: 'show' }))
    choice = L.endsOnChoice && L.endsOnChoice(e.answer) ? e.turn : ''
  }
}
const count = {}
for (const i of l.items) { const k = `${i.source}:${i.state}`; count[k] = (count[k] || 0) + 1 }
const end = T0 + events[events.length - 1].t * 1000
console.log(`items ${l.items.length}`)
console.log(`by source:state ${Object.keys(count).sort().map(k => `${k}=${count[k]}`).join(' ')}`)
console.log(`nudge items ${l.items.filter(i => /no need to reply/.test(i.text)).length}`)
console.log(`resent pairs counted twice ${['toolbox flag', 'billing-svc logs', 'acme-web sidebar'].filter(m => l.items.filter(i => i.text.includes(m)).length > 1).length}`)
const landed = l.items.find(i => i.source === 'promise' && i.text.includes('#12'))
console.log(`done-but-stale promise: ${landed ? landed.state : 'none'}`)
const video = l.items.find(i => i.text.includes('release screenshots'))
console.log(`waiting on the person: ${video ? video.state : 'none'}`)
console.log(`bare answers made items ${l.items.filter(i => i.text === 'ok go with 2' || i.text === '24.1').length}`)
console.log(`open now ${L.openItems(l, end).length}`)
