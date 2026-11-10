#!/usr/bin/env node
// test/helpers/waiting-check.mjs — "waiting on you": the reply a tap on a waiting item sends,
// against the ledger that has to understand it.
//
//     node test/helpers/waiting-check.mjs
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE CONTRACT BETWEEN TWO FILES THAT NEVER IMPORT EACH OTHER. web/ui/queue.jsx's replyText() is
// the message a reply to a waiting item sends to its master; mods/ghostfleet/hooks/ledger.js's
// wakeWaiting() is what decides, from the words of that message, that the owner replied to it.
// If the reply stopped quoting the item, every reply would arrive, be read, and leave the item
// `waiting` on the owner's list as if the owner had never written: no error anywhere, only a list
// that does not move. So the reply is fed through the real addPrompt the mod runs on a delivered
// prompt, and the item has to come out `replied` — and an item it does not quote has to stay where
// it was, or the check would pass for a ledger that wakes everything.
//
// queue.jsx is JSX, which node cannot import, so the one pure function is lifted out of it and
// called (pwa-check does the same with sw.js's pushText). The card's own rows went with the old
// client's waitingModel(): the Queue is web/ui's screen now, in both apps.
import fs from 'node:fs';
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const QUEUE = new URL('../../web/ui/queue.jsx', import.meta.url);
const src = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8') : '';
is('the queue screen is there', true, !!src);
const lifted = (/export const replyText = (\(row, text\) => [^\n]*);/.exec(src) || [])[1] || '';
let replyText = null;
try { replyText = lifted ? eval(lifted) : null; } catch {}
is('...and its reply is testable', 'function', typeof replyText);
// ...and it is what the screen SENDS: a reply built one way and sent another is the same silence.
is('...and it is what the screen sends to the master', true,
   /act\('fleet_send', \{ project: row\.project, session: 'master', prompt: replyText\(row, text\) \}\)/.test(src));

const L = await import(new URL('../../mods/ghostfleet/hooks/ledger.js', import.meta.url).href);
const row = { project: 'acme-api', profile: 'work', session: 'master', id: '7', text: 'merge #12 now, or wait for the billing-svc review?',
              state: 'waiting', reason: 'waits on the person: pick merge now or wait' };
// An answer that shares NO word with the ask, which is the common one ("yes", "go ahead", "the
// second"): with words of its own in common the answer alone would wake the item, and this row
// would pass for a reply that had stopped quoting it. Measured: it did.
const text = replyText ? replyText(row, '  go ahead  ') : '';
is('the reply quotes the item, by id and words, then says the answer', 'Re your ledger item 7: "merge #12 now, or wait for the billing-svc review?"\n\ngo ahead', text);
const H = 3_600_000, now = 100 * 24 * H;
const ledger = { v: 1, seq: 8, prompt: 3, window: 3, items: [
  { id: '7', text: row.text, at: now - 3 * H, state: 'waiting', source: 'user', progress: { at: now - 2 * H, reason: row.reason } },
  { id: '8', text: 'send the staging login for the checkout screenshots', at: now - 3 * H, state: 'waiting', source: 'user', progress: { at: now - 2 * H, reason: 'waits on the person: the login' } },
] };
// as DELIVERY records a prompt fleet-send handed over: one item, whole
const after = (text && L.addPrompt(ledger, { text, at: now, source: 'fleet', whole: true })) || { ...ledger, items: [] };
is('delivered, the reply makes ITS item replied, and leaves the other waiting', '8:waiting,7:replied',
   L.heldItems(after, now).map(i => `${i.id}:${i.state}`).join(','));
const closed = { ...after, items: after.items.map(i => (i.id === '7' ? { ...i, state: 'done', closedBy: 'agent', proof: 'merged #12' } : i)) };
is('...and once the master closes it, it is off the list', '8:waiting', L.heldItems(closed, now).map(i => `${i.id}:${i.state}`).join(','));

process.stdout.write(rows.join('\n') + '\n');
process.exit(0);
