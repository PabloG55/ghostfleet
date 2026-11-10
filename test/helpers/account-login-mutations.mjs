// Only edits the rig's disposable runtime, never the checkout or an installed runtime.
import fs from 'node:fs';
import path from 'node:path';
export function mutateAccountLogin(rt, name) {
  const cases = {
    'start-disabled': ['lib/account-logins.mjs', 'export async function startAccountLogin(projects, args) {', "export async function startAccountLogin(projects, args) { return reply('disabled');"],
    'finish-disabled': ['lib/account-logins.mjs', 'export async function finishAccountLogin(projects, args, records) {', "export async function finishAccountLogin(projects, args, records) { return reply('disabled');"],
    'skip-clear': ['lib/account-logins.mjs', "tmux(r.sock, 'clear-history', '-t', r.pane);", '// deliberately retain history'],
  };
  const c = cases[name]; if (!c) throw new Error('unknown mutation');
  const file = path.join(rt, c[0]), before = fs.readFileSync(file, 'utf8');
  if (!before.includes(c[1])) throw new Error('mutation target missing');
  fs.writeFileSync(file, before.replace(c[1], c[2]));
}
