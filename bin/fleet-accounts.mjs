#!/usr/bin/env node
// fleet-accounts — several Claude logins for one profile, spending what expires first.
//
//   fleet-accounts [list] [<profile>]       accounts, which is active, 5h/7d and how old each figure is
//   fleet-accounts add <profile> <name>     save the login the profile's config dir holds NOW
//   fleet-accounts remove <profile> <name>  forget a saved login
//   fleet-accounts use <profile> <name>     switch the profile to it now, and keep it there 2h
//   fleet-accounts threshold [<pct>]        show or set the switch point (default 97)
//
// Of the accounts under the threshold on BOTH the 5h and 7d windows, the profile runs on the
// one whose 7d window resets soonest (its unspent allowance is the next to be lost); weeks
// ending within 5h of each other are a tie, won by more 7d room. It leaves an account at the
// threshold, and comes back once that account's 5h window resets. A planned switch waits 15
// minutes after the last one, needs a week ending more than 5h sooner, and is never made onto
// an account last read over 6h ago (`stale` in the list) — that one is only a failover.
// Figures come only from real turns on the login in use, so an inactive account's are as old
// as `list` says. A turn refused with Claude's "You've hit your … limit · resets …" marks
// that account OUT until the reset it names; it is left at once and never chosen before then.
// An account its organization has disabled for Claude Code is BLOCKED and skipped: a /login
// cannot fix that, only an admin of that organization can.
// With every account spent, the profile's workers are parked until the earliest reset —
// except in a project whose budget limit is `ignored` (the grid's settings, <sock>.governor-off):
// its workers keep running until Claude itself refuses, and are never parked for this.
//
// [experimental] off on a new install — enable with: fleet-experimental enable accounts
//
// HOW AN ACCOUNT GETS IN. ghostfleet never drives a browser login and never sees a password:
// you log in with Claude Code's own /login, in a session of that profile, and `add` copies
// the login the config dir now holds into the OS secret store. Do it once per account:
//     /login as A   ->  fleet-accounts add work main
//     /login as B   ->  fleet-accounts add work backup
// The order you add them in only breaks ties. The governor of each of the profile's fleets
// then reads the 5h and 7d figures and swaps in the login the rule above picks — what a
// /login by hand does, and like one it restarts no session: each running Claude moves onto
// it by itself within half a minute (lib/accounts.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from '../lib/accounts.mjs';
import * as X from '../lib/experimental.mjs';
import { cfgFor } from '../lib/projects.mjs';

const die = (msg, code = 1) => { process.stderr.write(`fleet-accounts: ${msg}\n`); process.exit(code); };
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'fleet-event.sh');
const PROFILE_RE = /^[A-Za-z0-9_-]+$/;
const prof = (p) => { if (!p || !PROFILE_RE.test(p)) die(`'${p || ''}' is not a profile name`, 2); return p === 'default' ? 'work' : p; };

// The figure, when its window resets, and how long ago it was read: an inactive account's
// figures are only as fresh as its last turn, and nothing here asks for newer ones. The words
// are A.describe()'s, which is also what the phone is shown (/api/usage); this is only columns.
function fmtWin(w, label) {
  if (!w) return `${label} —`.padEnd(44);
  return `${label} ${String(w.pct).padStart(3)}% (resets ${w.resets_at}, read ${w.read})`.padEnd(44);
}
function list(only) {
  const thr = A.threshold();
  const profs = only ? [prof(only)] : A.profiles();
  console.log(`accounts${X.enabled('accounts') ? '' : ' — DISABLED: ' + X.howToEnable('accounts')}; switch at ${thr}% of the 5h or 7d limit, spending the week that ends first`);
  if (!profs.length) { console.log('  no profile has an account yet — fleet-accounts add <profile> <name>'); return; }
  for (const p of profs) {
    const d = A.describe(p, thr);
    console.log(`\n${p}  (${cfgFor(p).replace(process.env.HOME || '\0', '~')})${d.unsaved ? '  — ON A LOGIN THAT IS NOT SAVED, failover paused (fleet-accounts add to manage it)' : d.exhausted ? `  — ALL EXHAUSTED${d.exhausted.until_at ? ' until ' + d.exhausted.until_at : ''}, ${A.WORKERS[d.exhausted.workers] || A.WORKERS.paused}` : ''}`);
    if (!d.accounts.length) { console.log('  (no accounts)'); continue; }
    if (d.accounts.length < 2) console.log('  one account: nothing to fail over to yet — add another');
    if (d.pin) console.log(`  on '${d.pin.account}' by hand until ${d.pin.until_at} — the planner leaves it there unless it runs out`);
    const w = Math.max(...d.accounts.map(a => a.name.length));
    for (const a of d.accounts) {
      console.log(`  ${a.active ? '*' : ' '} ${a.name.padEnd(w)}  ${fmtWin(a.five_hour, '5h')} ${fmtWin(a.seven_day, '7d')} ${a.state}${a.active && a.state !== 'active' ? ' (active)' : ''}`);
      if (a.fix) console.log(`    ${a.fix}`);
    }
  }
}

async function main() {
  const [cmd = 'list', a1, a2] = process.argv.slice(2);
  if (['-h', '--help', 'help'].includes(cmd)) {
    return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
  if (cmd === 'list') return list(a1);
  if (!X.enabled('accounts')) die(X.disabledWhy('accounts', 'fleet-accounts'));
  switch (cmd) {
    case 'add': {
      const p = prof(a1); if (!a2) die('add needs <profile> <name>', 2);
      let r; try { r = A.add(p, a2); } catch (e) { die(e.message); }
      if (!r) die('another fleet-accounts is holding the profile — try again in a moment');
      const wired = A.wireStopFailure(cfgFor(p), HOOK);
      console.log(`${p}/${a2}: ${r.readded ? 'login saved again (any NEEDS-LOGIN mark is cleared)' : 'login saved'} — ${r.st.order.length} account${r.st.order.length === 1 ? '' : 's'}: ${r.st.order.join(' → ')}`);
      console.log(`  ${p} is now running on '${a2}' (it is the login the config dir holds).`);
      if (wired) console.log(`  wired the StopFailure hook into ${cfgFor(p)}/settings.json, so a login refused mid-turn is seen`);
      if (r.st.order[0] !== a2 && r.st.order.length > 1) console.log(`  to go back to '${r.st.order[0]}' now: fleet-accounts use ${p} ${r.st.order[0]}`);
      console.log(`  next account: ${A.loginCmd(p, '<name>')}`);
      return;
    }
    case 'remove': {
      const p = prof(a1); if (!a2) die('remove needs <profile> <name>', 2);
      let st; try { st = A.remove(p, a2); } catch (e) { die(e.message); }
      return console.log(`${p}/${a2}: removed — ${st.order.length ? st.order.join(' → ') : 'no accounts left'}`);
    }
    case 'use': {
      const p = prof(a1); if (!a2) die('use needs <profile> <name>', 2);
      let r; try { r = A.use(p, a2); } catch (e) { die(e.message); }
      if (r.wasOut) console.log(`${p}/${a2} hit its ${r.wasOut.why} (Claude said until ${A.hhmm(r.wasOut.until)}) — using it anyway, by hand; a turn refused at the limit again marks it out and moves on`);
      if (r.same) return console.log(`${p} is already on '${a2}' — kept there until ${A.hhmm(r.st.pin.until)} unless it runs out`);
      return console.log(`${p}: switched to '${a2}' — running sessions move onto it by themselves within half a minute, as after a /login; nothing is restarted. Kept there until ${A.hhmm(r.st.pin.until)} unless it runs out`);
    }
    case 'threshold': {
      if (a1 === undefined) return console.log(`${A.threshold()}`);
      const v = Number(a1);
      if (!Number.isInteger(v) || v < 1 || v > 100) die(`threshold is a whole percentage, 1-100 (got '${a1}')`, 2);
      A.setThreshold(v);
      return console.log(`accounts switch at ${v}% of the 5h or 7d limit`);
    }
    default: die(`unknown command '${cmd}' (fleet-accounts --help)`, 2);
  }
}
main().catch((e) => die(String((e && e.stack) || e)));
