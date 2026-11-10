// Only edits the rig's disposable runtime, never the checkout or an installed runtime.
import fs from 'node:fs';
import path from 'node:path';
export function mutateAccountLogin(rt, name) {
  const cases = {
    'start-disabled': ['lib/account-logins.mjs', 'export async function startAccountLogin(projects, args) {', "export async function startAccountLogin(projects, args) { return reply('disabled');"],
    'finish-disabled': ['lib/account-logins.mjs', 'export async function finishAccountLogin(projects, args, records) {', "export async function finishAccountLogin(projects, args, records) { return reply('disabled');"],
    'skip-clear': ['lib/account-logins.mjs', "tmux(r.sock, 'clear-history', '-t', r.pane);", '// deliberately retain history'],
    'busy': ['lib/account-logins.mjs', 'if (accountBusy(pane))', 'if (false)'],
    'expired': ['lib/account-logins.mjs', 'if (r.expires <= Date.now())', 'if (false)'],
    'prompt': ['lib/account-logins.mjs', 'if (!accountLoginPrompt(pane) || accountLoginURL(pane) !== r.authorize)', 'if (false)'],
    'local-passkey': ['bin/fleet-serve.mjs', 'if (!req.client.pair && (!a || a.error))', 'if (false)'],
    'home-passkey': ['bin/fleet-serve.mjs', "if (!a || a.error) { send(res, 401, { ok: false, needs: 'passkey', text: 'finishing a login needs a fresh passkey assertion' }); return true; }", 'if (false) return true;'],
    'signature': ['lib/peers.mjs', 'if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)))', 'if (false)'],
    'replay': ['lib/peers.mjs', "if (seen.has(k)) return { error: 'that signed request has already been used once' };", '// replay guard removed'],
    'scope': ['bin/fleet-serve.mjs', 'await finishAccountLogin(shownTo(req), body.args || {}, loginRecords(shownTo(req)))', 'await finishAccountLogin(projects(), body.args || {}, loginRecords(projects()))'],
    'secret-log': ['lib/account-logins.mjs', 'let code = args.code;', "let code = args.code; fs.writeFileSync(path.join(tSafeDir(projects), 'leaked-code'), code);"],
    'crossing-disabled': ['bin/fleet-serve.mjs', ", 'fleet_account_login_start', 'fleet_account_login_finish'", ''],
  };
  const c = cases[name]; if (!c) throw new Error('unknown mutation');
  const file = path.join(rt, c[0]), before = fs.readFileSync(file, 'utf8');
  if (!before.includes(c[1])) throw new Error('mutation target missing');
  let after = before.replaceAll(c[1], c[2]);
  if (name === 'secret-log') after += '\nfunction tSafeDir(projects) { return projects[0].cfg; }\n';
  fs.writeFileSync(file, after);
}
