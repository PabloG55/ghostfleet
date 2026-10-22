#!/usr/bin/env node
// test/helpers/fake-login.mjs — plant and read FAKE Claude logins, through lib/accounts.mjs's
// own store code, for the accounts rows. Only ever under a fake HOME with a fake store
// (CLAUDE_FLEET_SECURITY=fake-security.mjs, or CLAUDE_FLEET_LOGIN_STORE=file): it refuses
// otherwise. Tokens are labels like `at-<tag>`, nothing real.
//
//   set <cfg> <who> <tag> [expiresAtMs] [refreshExpiresAtMs]   the config dir's live login
//   blank <cfg>                     what Claude Code does on invalid_grant: tokens emptied
//   live <cfg>                      "<who> <accessToken>"
//   saved <profile> <cfg> <name>    "<who> <accessToken>" of a saved account, or nothing
//   deadsaved <profile> <cfg> <name>  that saved account's refresh token expired a minute ago
import os from 'node:os';
import * as A from '../../lib/accounts.mjs';

const fakeStore = process.env.CLAUDE_FLEET_LOGIN_STORE === 'file' || /fake-security/.test(process.env.CLAUDE_FLEET_SECURITY || '');
if (!fakeStore || !process.env.HOME || process.env.HOME === os.userInfo().homedir) {
  process.stderr.write('fake-login: refusing — needs a fake HOME and a fake store\n'); process.exit(2);
}
const who = (acct) => (acct && acct.accountUuid ? acct.accountUuid.replace(/^uuid-/, '') : '-');
const [cmd, a, b, c, d, e] = process.argv.slice(2);
if (cmd === 'set') {
  A.writeLive(a, { accessToken: `at-${c}`, refreshToken: `rt-${c}`, expiresAt: Number(d) || Date.now() + 8 * 3600e3,
                   ...(e ? { refreshTokenExpiresAt: Number(e) } : {}), scopes: ['user:inference'], subscriptionType: 'max' },
              { accountUuid: `uuid-${b}`, organizationUuid: 'org-1', emailAddress: `${b}@example.com` });
} else if (cmd === 'blank') {
  const l = A.readLive(a);
  A.writeLive(a, { ...l.oauth, accessToken: '', refreshToken: '', expiresAt: 0 }, l.account);
} else if (cmd === 'live') {
  const l = A.readLive(a);
  console.log(l ? `${who(l.account)} ${(l.oauth && l.oauth.accessToken) || '-'}` : '');
} else if (cmd === 'saved') {
  const s = A.readSaved(a, b, c);
  console.log(s ? `${who(s.oauthAccount)} ${(s.claudeAiOauth && s.claudeAiOauth.accessToken) || '-'}` : '');
} else if (cmd === 'deadsaved') {
  const s = A.readSaved(a, b, c);
  A.writeSaved(a, b, c, { ...s.claudeAiOauth, refreshTokenExpiresAt: Date.now() - 60e3 }, s.oauthAccount);
} else { process.stderr.write('fake-login: set|blank|live|saved|deadsaved\n'); process.exit(2); }
