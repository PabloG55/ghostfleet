#!/usr/bin/env node
// test/helpers/push-hold-check.mjs — the at-the-Mac hold, driven as a table.
//
//     HOME=<scratch> node push-hold-check.mjs      # one `name \x1f want \x1f got` row per check
//
// bin/fleet-serve.mjs holds a push while the owner is at the Mac and sends ONE when he
// leaves, if what was held is still unseen; after at_mac_hold seconds it drops it. The
// decision is holdStep(), pure — no clock, no ioreg — so every rule is a row here, and each
// rule has a row on the other side of it: a hold that never released, or a release that
// ignored "seen", would pass half of these and fail the other half.
//
// The readings are injected (atMac() takes {idle, locked}), and the two parsers are fed the
// exact text ioreg prints, so a change in what they accept shows up here rather than as a
// phone that buzzes while he types.
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const { holdStep, atMac, pushResolved, parseHidIdle, parseConsoleLocked } =
  await import(new URL('../../bin/fleet-serve.mjs', import.meta.url).href);

// ── the readings ──────────────────────────────────────────────────────────
// Verbatim shapes from `ioreg -c IOHIDSystem -r -k HIDIdleTime -d 1` and `ioreg -n Root -d 1`.
is('HIDIdleTime is nanoseconds, read as seconds', 14.708, Math.round(parseHidIdle('    |   "HIDIdleTime" = 14708018750\n') * 1000) / 1000);
is('...and no line means no reading, not zero', null, parseHidIdle('+-o IOHIDSystem  <class IOHIDSystem>\n'));
is('IOConsoleLocked = Yes is locked', true, parseConsoleLocked('  | "IOConsoleLocked" = Yes\n'));
is('IOConsoleLocked = No is unlocked', false, parseConsoleLocked('  | "IOConsoleLocked" = No\n'));
is('...and an absent key is unknown', null, parseConsoleLocked('  | "IOConsoleUsers" = ()\n'));

is('input 10s ago, unlocked: at the Mac', true, atMac({ idle: 10, locked: false }, 120));
is('input 130s ago: not at the Mac', false, atMac({ idle: 130, locked: false }, 120));
is('input 10s ago but LOCKED: not at the Mac', false, atMac({ idle: 10, locked: true }, 120));
is('at_mac_idle 0 turns it off', false, atMac({ idle: 1, locked: false }, 0));
is('no reading (Linux, ioreg failed) is never "at the Mac"', false, atMac(null, 120));

// ── the step ──────────────────────────────────────────────────────────────
const need = { kind: 'needs-you', project: 'acme-api', session: 'api-fix', sock: 'cf-acme-api' };
const ans = { kind: 'answer', project: 'acme-web', session: 'master', sock: 'cf-acme-web' };
const status = (m) => (k) => m[k];
const live = status({ 'cf-acme-api/api-fix': 'need-you', 'cf-acme-web/master': 'ready' });
const base = { hold: 600, readAt: 0, status: live };

// 1. at the Mac: nothing goes, both are held
let r = holdStep([], { ...base, events: [need, ans], here: true, now: 1000 });
is('at the Mac, nothing is sent', 0, r.send.length);
is('...both are held', 2, r.held.length);
is('...and it is logged as held', true, r.log.some(l => /^push: held 2 — at the Mac$/.test(l)));
// the other side of rule 1
let r0 = holdStep([], { ...base, events: [need], here: false, now: 1000 });
is('away from the Mac, it is sent at once', 1, r0.send.length);
is('...and nothing is held', 0, r0.held.length);

// 2. still at the Mac a minute later: still held, nothing sent, nothing logged
let r2 = holdStep(r.held, { ...base, events: [], here: true, now: 1060 });
is('still at the Mac, still held', 2, r2.held.length);
is('...and still nothing sent', 0, r2.send.length);
is('...with nothing to log', 0, r2.log.length);

// 3. he leaves: ONE release with both
let r3 = holdStep(r2.held, { ...base, events: [], here: false, now: 1200 });
is('leaving the Mac releases what was held', 2, r3.send.length);
is('...in one step, so one push', 2, r3.released);
is('...and holds nothing after', 0, r3.held.length);
is('...logged as released', true, r3.log.some(l => /^push: released 2 held — left the Mac$/.test(l)));
// a release folds in anything fresh, still one push
let r3b = holdStep(r2.held, { ...base, events: [{ ...need, session: 'api-docs' }], here: false, now: 1200 });
is('a fresh event on the way out rides the same push', 3, r3b.send.length);

// 4. seen: the phone polled after the event
let r4 = holdStep(r2.held, { ...base, readAt: 1100, events: [], here: false, now: 1200 });
is('polled after it: dropped as seen, not sent', 0, r4.send.length);
is('...logged as seen', true, r4.log.some(l => /^push: dropped 2 held as seen$/.test(l)));
// the other side: a poll BEFORE the event does not count
let r4b = holdStep(r2.held, { ...base, readAt: 900, events: [], here: false, now: 1200 });
is('a poll from before the event is not seeing it', 2, r4b.send.length);

// 5. resolved: answered at the Mac
const moved = status({ 'cf-acme-api/api-fix': 'working', 'cf-acme-web/master': 'working' });
let r5 = holdStep(r2.held, { ...base, status: moved, events: [], here: false, now: 1200 });
is('answered at the Mac: nothing left to send', 0, r5.send.length);
const half = status({ 'cf-acme-api/api-fix': 'need-you', 'cf-acme-web/master': 'working' });
let r5b = holdStep(r2.held, { ...base, status: half, events: [], here: false, now: 1200 });
is('...only the one he dealt with goes', 'needs-you', r5b.send.map(e => e.kind).join(','));
is('a need-you still blocked is not resolved', false, pushResolved(need, 'need-you'));
is('a need-you that is working again is', true, pushResolved(need, 'working'));
is('an answer still sitting there is not', false, pushResolved(ans, 'ready'));
is('an answer replied to (working again) is', true, pushResolved(ans, 'working'));
is('a session that is gone is', true, pushResolved(ans, undefined));

// 6. expired: ten minutes at the Mac and it is dropped, even when he then leaves
let r6 = holdStep(r2.held, { ...base, events: [], here: false, now: 1000 + 600 });
is('600s after it was held, it expires', 0, r6.send.length);
is('...logged as expired', true, r6.log.some(l => /^push: expired 2 held after 600s at the Mac$/.test(l)));
let r6b = holdStep(r2.held, { ...base, events: [], here: false, now: 1000 + 599 });
is('...but at 599s it is still released', 2, r6b.send.length);
let r6c = holdStep(r2.held, { ...base, events: [], here: true, now: 1000 + 700 });
is('expiry runs while he is still at the Mac, too', 0, r6c.held.length);

// 7. a newer event for the same session replaces the held one: one line per session
let r7 = holdStep(r2.held, { ...base, events: [{ ...need }], here: true, now: 1100 });
is('a newer event for a held session supersedes it', 2, r7.held.length);
is('...the newer one is what is held', 1100, (r7.held.find(h => h.ev.session === 'api-fix') || {}).at);

console.log(rows.join('\n'));
