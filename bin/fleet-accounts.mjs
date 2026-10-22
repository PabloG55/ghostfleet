#!/usr/bin/env node
// fleet-accounts — several Claude logins for one profile, and failover between them.
//
//   fleet-accounts [list] [<profile>]       accounts in order, which is active, 5h/7d, state
//   fleet-accounts add <profile> <name>     save the login the profile's config dir holds NOW
//   fleet-accounts remove <profile> <name>  forget a saved login
//   fleet-accounts use <profile> <name>     switch the profile to it now
//   fleet-accounts threshold [<pct>]        show or set the switch point (default 97)
//
// [experimental] off on a new install — enable with: fleet-experimental enable accounts
//
// HOW AN ACCOUNT GETS IN. ghostfleet never drives a browser login and never sees a password:
// you log in with Claude Code's own /login, in a session of that profile, and `add` copies
// the login the config dir now holds into the OS secret store. Do it once per account:
//     /login as A   ->  fleet-accounts add work main
//     /login as B   ->  fleet-accounts add work backup
// The order you add them in is the order they are used. The governor of each of the profile's
// fleets then watches the active account's 5h and 7d figures and, at the threshold, swaps the
// next account's login in and relaunches each session as its turn ends (lib/accounts.mjs).
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

function fmtWin(w, label) {
  if (!w) return `${label} —`.padEnd(27);
  return `${label} ${String(Math.floor(w.pct)).padStart(3)}% (resets ${A.hhmm(w.resets)})`.padEnd(27);
}
function list(only) {
  const thr = A.threshold();
  const profs = only ? [prof(only)] : A.profiles();
  console.log(`accounts${X.enabled('accounts') ? '' : ' — DISABLED: ' + X.howToEnable('accounts')}; switch at ${thr}% of the 5h or 7d limit`);
  if (!profs.length) { console.log('  no profile has an account yet — fleet-accounts add <profile> <name>'); return; }
  for (const p of profs) {
    const st = A.load(p);
    console.log(`\n${p}  (${cfgFor(p).replace(process.env.HOME || '\0', '~')})${A.onUnsaved(st) ? '  — ON A LOGIN THAT IS NOT SAVED, failover paused (fleet-accounts add to manage it)' : st.exhausted ? `  — ALL EXHAUSTED${st.exhausted.until ? ' until ' + A.hhmm(st.exhausted.until) : ''}, workers paused` : ''}`);
    if (!st.order.length) { console.log('  (no accounts)'); continue; }
    if (st.order.length < 2) console.log('  one account: nothing to fail over to yet — add another');
    const w = Math.max(...st.order.map(n => n.length));
    for (const n of st.order) {
      const a = st.accounts[n] || {};
      const over = A.overBy(a, thr);
      let state = n === st.active ? 'active' : 'ready';
      if (a.needs_login) state = 'NEEDS-LOGIN';
      else if (over) state = `exhausted until ${A.hhmm(over.resets)}`;
      const u = a.usage || {};
      console.log(`  ${n === st.active ? '*' : ' '} ${n.padEnd(w)}  ${fmtWin(u.five_hour, '5h')} ${fmtWin(u.seven_day, '7d')} ${state}${n === st.active && state !== 'active' ? ' (active)' : ''}`);
      if (a.needs_login) console.log(`    ${a.needs_login.why} — run: ${A.loginCmd(p, n)}`);
    }
  }
}

async function main() {
  const [cmd = 'list', a1, a2] = process.argv.slice(2);
  if (['-h', '--help', 'help'].includes(cmd)) {
    return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
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
      if (r.same) return console.log(`${p} is already on '${a2}'`);
      return console.log(`${p}: switched to '${a2}' — each session is relaunched onto it as its turn ends (by the fleet's governor, within a minute)`);
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
