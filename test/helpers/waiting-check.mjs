#!/usr/bin/env node
// test/helpers/waiting-check.mjs — "waiting on you" on the phone: the card a held item draws,
// and the reply it sends, against the ledger that has to understand it.
//
//     node test/helpers/waiting-check.mjs
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE CONTRACT BETWEEN TWO FILES THAT NEVER IMPORT EACH OTHER. web/app.js's replyText() is
// the message a tap on a waiting item sends to its master; mods/ghostfleet/hooks/ledger.js's
// wakeWaiting() is what decides, from the words of that message, that the owner replied to it.
// If the reply stopped quoting the item, every reply would arrive, be read, and leave the
// item `waiting` on the owner's list as if the owner had never written: no error anywhere, only a
// list that does not move. So the reply is fed through the real addPrompt the mod runs on a
// delivered prompt, and the item has to come out `replied` — and an item it does not quote
// has to stay where it was, or the check would pass for a ledger that wakes everything.
//
// Its own twenty lines of DOM, for speak-check.mjs's reason: importing app.js runs its boot
// block, and nothing here touches a screen.
import { fileURLToPath } from 'node:url';
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const noop = () => {};
class Node_ {
  constructor(tag) {
    this.tag = tag; this.kids = []; this.attrs = {}; this.className = ''; this._text = null;
    this.value = ''; this.style = { cssText: '', setProperty: noop }; this.dataset = {};
    this.classList = { contains: () => false, add: noop, remove: noop, toggle: noop };
  }
  set textContent(v) { this.kids.length = 0; this._text = String(v); }
  get textContent() { return (this._text || '') + this.kids.map(k => k.textContent).join(' '); }
  set innerHTML(v) { this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  append(...ks) { for (const k of ks) if (k != null) this.kids.push(k); }
  appendChild(k) { this.kids.push(k); return k; }
  remove() {} focus() {} blur() {}
  get firstChild() { return this.kids[0] || null; }
  getBoundingClientRect() { return { width: 800, height: 20 }; }
  querySelector() { return null; }
}
const appHost = new Node_('div'), sheetHost = new Node_('div');
for (const [name, value] of [
  ['document', { hidden: false, documentElement: new Node_('html'), body: new Node_('body'),
    createElement: t => new Node_(t),
    createTextNode: t => { const n = new Node_('#text'); n.textContent = t; return n; },
    getElementById: id => (id === 'app' ? appHost : id === 'sheet' ? sheetHost : null),
    querySelectorAll: () => [], addEventListener: noop }],
  ['localStorage', (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()],
  ['addEventListener', noop],
  ['history', { length: 1, pushState: noop, replaceState: noop, back: noop, go: noop }],
  ['window', { isSecureContext: false }],
  ['navigator', {}],
  ['setInterval', () => 0],
  ['location', { href: 'file:///', origin: 'null', protocol: 'file:', host: '', hostname: '' }],
  ['getSelection', () => ''],
]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });

const APP = await import(new URL('../../web/app.js', import.meta.url).href);
const L = await import(new URL('../../mods/ghostfleet/hooks/ledger.js', import.meta.url).href);

// ── the card ──────────────────────────────────────────────────────────────
const nowS = 1_000_000;
const row = { project: 'acme-api', profile: 'work', session: 'master', id: '7', text: 'merge #12 now, or wait for the billing-svc review?',
              state: 'waiting', reason: 'waits on the person: pick merge now or wait', at: nowS - 9000, since: nowS - 7200 };
const m = APP.waitingModel(row, nowS);
is('the card is titled with the project', 'acme-api', m.title);
is('...says it waits on the owner, in the need-you hue', '● waiting on you/red', `${m.statusLabel}/${m.color}`);
is('...says how long it has WAITED (since it started waiting, not since it was asked)', '2h0m', m.when);
is('...quotes the ask on one line', '“merge #12 now, or wait for the billing-svc review?”/true', `${m.msg}/${m.one}`);
is('...and says what the master needs, without the judge\'s "waits on the person"', 'needs: pick merge now or wait', m.need);
is('...and which item, of which session', 'master · #7', m.where);
const ans = APP.waitingModel({ ...row, state: 'replied', since: nowS - 60 }, nowS);
is('one the owner replied to is grey and says the master has it', 'grey/↩ you replied/true', `${ans.color}/${ans.statusLabel}/${/master has not closed it/.test(ans.need)}`);
const car = APP.waitingModel({ ...row, id: '12', text: '[cache-keys] pick the TTL', state: 'open', reason: '', since: nowS - 5 * 3600,
                               from: 'cache-keys', was: 'waiting', note: 'waits on the person: a TTL' }, nowS);
is('a carried one says which worker it came from and what it last said', 'cache-keys stopped while waiting: waits on the person: a TTL', car.need);
const open = APP.waitingModel({ ...row, state: 'open', reason: '', since: nowS - 5 * 3600 }, nowS);
is('an untouched open request is yellow, and says why it is listed', 'yellow/○ open, untouched/no word on it for hours', `${open.color}/${open.statusLabel}/${open.need}`);

// A HELD WAKE (fleet-serve heldWakes) is not a ledger item and has no id to quote: the card
// names the lead whose box is holding it and says what the owner can do, and never "#held".
const hw = APP.waitingModel({ project: 'acme-api', profile: 'work', session: 'master', key: 'held:cf-acme-api/master', id: 'held',
                              state: 'held', text: "master's input box has unsent text", reason: 'x', at: nowS - 900, since: nowS - 900 }, nowS);
is('a held wake is red and says so', 'red/▲ wake held', `${hw.color}/${hw.statusLabel}`);
is('...names the lead, not an item number', 'master', hw.where);
is('...says what is in the way, unquoted', "master's input box has unsent text", hw.msg);
is('...and that the box is the owner\'s to send or clear, never the fleet\'s', true, /send or clear/.test(hw.need) && /never/.test(hw.need));

// ── the reply, and the ledger that reads it ───────────────────────────────
// An answer that shares NO word with the ask, which is the common one ("yes", "go ahead",
// "the second"): with words of its own in common the answer alone would wake the item, and
// this row would pass for a reply that had stopped quoting it. Measured: it did.
const text = APP.replyText(row, '  go ahead  ');
is('the reply quotes the item, by id and words, then says the answer', 'Re your ledger item 7: "merge #12 now, or wait for the billing-svc review?"\n\ngo ahead', text);
const H = 3_600_000, now = 100 * 24 * H;
const ledger = { v: 1, seq: 8, prompt: 3, window: 3, items: [
  { id: '7', text: row.text, at: now - 3 * H, state: 'waiting', source: 'user', progress: { at: now - 2 * H, reason: row.reason } },
  { id: '8', text: 'send the staging login for the checkout screenshots', at: now - 3 * H, state: 'waiting', source: 'user', progress: { at: now - 2 * H, reason: 'waits on the person: the login' } },
] };
// as DELIVERY records a prompt fleet-send handed over: one item, whole
const after = L.addPrompt(ledger, { text, at: now, source: 'fleet', whole: true });
const held = L.heldItems(after, now).map(i => `${i.id}:${i.state}`).join(',');
is('delivered, the reply makes ITS item replied, and leaves the other waiting', '8:waiting,7:replied', held);
const closed = { ...after, items: after.items.map(i => (i.id === '7' ? { ...i, state: 'done', closedBy: 'agent', proof: 'merged #12' } : i)) };
is('...and once the master closes it, it is off the list', '8:waiting', L.heldItems(closed, now).map(i => `${i.id}:${i.state}`).join(','));

process.stdout.write(rows.join('\n') + '\n');
process.exit(0);
