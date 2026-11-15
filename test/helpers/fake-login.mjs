#!/usr/bin/env node
// test/helpers/fake-login.mjs — plant and read FAKE Claude logins, through lib/accounts.mjs's
// own store code, for the accounts rows. Only ever under a fake HOME with a fake store
// (CLAUDE_FLEET_SECURITY=fake-security.mjs, or CLAUDE_FLEET_LOGIN_STORE=file): it refuses
// otherwise. Tokens are labels like `at-<tag>`, nothing real.
//
//   set <cfg> <who>[@<org>] <tag> [expiresAtMs] [refreshExpiresAtMs]   the config dir's live
//                                   login; with $FAKE_PROFILE_DIR the profile stub
//                                   (profile-stub.mjs) answers for its token as <who> in <org>
//   lie <cfg> <who>[@<org>]         .claude.json alone names somebody else, tokens untouched: a
//                                   running session writing back the account it started on
//   forget <tag>                    the stub refuses at-<tag> from now on (revoked, or expired)
//   blank <cfg>                     what Claude Code does on invalid_grant: tokens emptied
//   live <cfg>                      "<who> <accessToken>"
//   saved <profile> <cfg> <name>    "<who> <accessToken>" of a saved account, or nothing
//   deadsaved <profile> <cfg> <name>  that saved account's refresh token expired a minute ago
//   plant <profile> <cfg> <name> <who>[@<org>] <tag> [expiresAtMs]  a saved copy holding THAT login, behind
//                                   the engine's back: the shape a write-back into the wrong
//                                   slot left
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from '../../lib/accounts.mjs';

const fakeStore = process.env.CLAUDE_FLEET_LOGIN_STORE === 'file' || /fake-security/.test(process.env.CLAUDE_FLEET_SECURITY || '');
if (!fakeStore || !process.env.HOME || process.env.HOME === os.userInfo().homedir) {
  process.stderr.write('fake-login: refusing — needs a fake HOME and a fake store\n'); process.exit(2);
}
const who = (acct) => (acct && acct.accountUuid ? acct.accountUuid.replace(/^uuid-/, '') : '-');
const [cmd, a, b, c, d, e] = process.argv.slice(2);
const split = (wo) => { const [w, o = 'org-1'] = String(wo).split('@'); return { w, o }; };
const reg = (tok, entry) => {
  const pd = process.env.FAKE_PROFILE_DIR; if (!pd) return;
  const f = path.join(pd, 'tokens.json');
  let m = {}; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (entry) m[tok] = entry; else delete m[tok];
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(m)); fs.renameSync(`${f}.tmp`, f);
};
if (cmd === 'set') {
  const { w, o } = split(b);
  A.writeLive(a, { accessToken: `at-${c}`, refreshToken: `rt-${c}`, expiresAt: Number(d) || Date.now() + 8 * 3600e3,
                   ...(e ? { refreshTokenExpiresAt: Number(e) } : {}), scopes: ['user:inference'], subscriptionType: 'max' },
              { accountUuid: `uuid-${w}`, organizationUuid: o, emailAddress: `${w}@example.com` });
  reg(`at-${c}`, { who: w, org: o, org_name: o });
} else if (cmd === 'lie') {
  const { w, o } = split(b), l = A.readLive(a);
  A.writeLive(a, l.oauth, { accountUuid: `uuid-${w}`, organizationUuid: o, emailAddress: `${w}@example.com` });
} else if (cmd === 'forget') {
  reg(`at-${a}`, null);
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
} else if (cmd === 'plant') {
  const { w, o } = split(d), tag = e, exp = Number(process.argv[8]) || Date.now() + 8 * 3600e3;
  A.writeSaved(a, b, c, { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt: exp,
                          scopes: ['user:inference'], subscriptionType: 'max' },
               { accountUuid: `uuid-${w}`, organizationUuid: o, emailAddress: `${w}@example.com` });
  reg(`at-${tag}`, { who: w, org: o, org_name: o });
} else { process.stderr.write('fake-login: set|lie|forget|plant|blank|live|saved|deadsaved\n'); process.exit(2); }
