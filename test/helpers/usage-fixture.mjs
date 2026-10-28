#!/usr/bin/env node
// test/helpers/usage-fixture.mjs — a fake HOME whose profiles hold every account state
// `fleet-accounts list` can print, for the rows that ask whether /api/usage says the same.
//
//     node test/helpers/usage-fixture.mjs <home> <now> [off]
//
// Writes, under <home>, the projects file (acme-api on `work`, toolbox on `personal`), the
// accounts switch (left OFF with `off`), and three accounts.json files read at clock <now>:
//   work      main active and fresh, pinned by hand; backup ready but read 8h ago (stale);
//             spare OUT on its weekly limit; extra NEEDS-LOGIN; old BLOCKED by its org.
//   personal  both accounts over the threshold, and the profile marked all-exhausted.
//   side      a profile with accounts but no project — fleet-serve lists no such profile,
//             so nothing of it may reach the phone.
// Every account also carries decoy `email`, `org` and token fields that a real state file
// never holds: an endpoint that copied the state through rather than picking from it would
// carry them out, and the row that greps for them would see it.
import fs from 'node:fs';
import path from 'node:path';

const [home, nowArg, off] = process.argv.slice(2);
if (!home || !nowArg) { process.stderr.write('usage: usage-fixture.mjs <home> <now> [off]\n'); process.exit(2); }
const NOW = Number(nowArg), H = 3600;
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const decoy = { email: 'decoy-owner@example.com', org: 'Decoy Org Ltd', accessToken: 'sk-ant-oat01-DECOYDECOY', refreshToken: 'sk-ant-ort01-DECOYDECOY' };
const win = (pct, resets, at) => ({ pct, resets, at });
const acct = (o) => ({ id: 'id-' + Math.random().toString(16).slice(2, 10), added_at: NOW - 30 * 24 * H, ...decoy, ...o });

put(path.join(home, '.config/ghostfleet/projects'), 'acme-api\t~/src/acme-api\twork\ntoolbox\t~/src/toolbox\tpersonal\n');
const sw = path.join(home, '.config/ghostfleet/accounts.enabled');
put(sw, off ? 'off\n' : 'on\n');   // written either way: with no file, an install holding an accounts.json reads as on

put(path.join(home, '.claude/fleet/accounts.json'), JSON.stringify({
  order: ['main', 'backup', 'spare', 'extra', 'old'], active: 'main',
  history: [{ account: 'main', from: NOW - 5 * H }],
  pin: { account: 'main', until: NOW + 107 * 60 },
  accounts: {
    main: acct({ usage: { five_hour: win(37.4, NOW + 130 * 60, NOW - 180), seven_day: win(42, NOW + 4 * 24 * H + 1800, NOW - 180) } }),
    backup: acct({ usage: { five_hour: win(12, NOW - 2 * H, NOW - 8 * H), seven_day: win(20, NOW + 3 * 24 * H, NOW - 8 * H) } }),
    spare: acct({ out: { at: NOW - H, until: NOW + 5 * H, limit: '7d', why: 'weekly limit', said: true },
                  usage: { five_hour: win(30, NOW + H, NOW - H), seven_day: win(64, NOW + 5 * H, NOW - H) } }),
    extra: acct({ needs_login: { at: NOW - 2 * H, why: 'its refresh token has expired' } }),
    old: acct({ blocked: { at: NOW - 3 * H, why: 'its organization has disabled Claude subscription access for Claude Code' } }),
  },
}, null, 2));
put(path.join(home, '.claude-personal/fleet/accounts.json'), JSON.stringify({
  order: ['main', 'backup'], active: 'main',
  history: [{ account: 'main', from: NOW - 9 * H }],
  exhausted: { since: NOW - 1800, until: NOW + 3 * H, notified: NOW - 1800 },
  accounts: {
    main: acct({ usage: { five_hour: win(99, NOW + 3 * H, NOW - 600), seven_day: win(71, NOW + 6 * 24 * H, NOW - 600) } }),
    backup: acct({ usage: { five_hour: win(20, NOW + 2 * H, NOW - 2 * H), seven_day: win(98, NOW + 2 * 24 * H, NOW - 2 * H) } }),
  },
}, null, 2));
put(path.join(home, '.claude-side/fleet/accounts.json'), JSON.stringify({
  order: ['hidden'], active: 'hidden', history: [],
  accounts: { hidden: acct({ usage: { five_hour: win(5, NOW + H, NOW - 60), seven_day: win(5, NOW + 2 * 24 * H, NOW - 60) } }) },
}, null, 2));
