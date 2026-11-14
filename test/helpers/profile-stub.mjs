#!/usr/bin/env node
// test/helpers/profile-stub.mjs <dir> — a stand-in for the provider's read-only profile
// request (GET /api/oauth/profile), for the accounts rows. It answers on 127.0.0.1 at a port
// it picks and writes to <dir>/port, so CLAUDE_FLEET_PROFILE_API=http://127.0.0.1:<port>.
//
// Who a token is lives in <dir>/tokens.json, re-read on every request, so a row changes the
// answer by writing the file: { "<accessToken>": { "who": "alice", "org": "org-1",
// "org_name": "acme" } }. A token it does not list is refused (401), as an expired or revoked
// one is; <dir>/down makes every request a 503, the provider not answering. Every request is
// a line in <dir>/requests.log ("<token> <status>"), which is how a row proves what was asked
// — and that nothing was asked of a refresh endpoint, because this serves no other path.
// The shape is the binary's own (2.1.321): account{uuid, email, display_name},
// organization{uuid, name}. Labels only, never a real token: test/helpers/fake-login.mjs
// writes the tokens this reads.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { process.stderr.write('profile-stub: needs <dir>\n'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const log = (tok, code) => { try { fs.appendFileSync(path.join(dir, 'requests.log'), `${tok || '-'} ${code}\n`); } catch {} };
const tokens = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')); } catch { return {}; } };

const srv = http.createServer((req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const send = (code, body) => { log(tok, code); res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/api/oauth/profile') return send(404, { error: 'not_found' });
  if (fs.existsSync(path.join(dir, 'down'))) return send(503, { error: 'overloaded' });
  const t = tokens()[tok];
  if (!t) return send(401, { error: { type: 'authentication_error' } });
  return send(200, {
    account: { uuid: `uuid-${t.who}`, email: `${t.who}@example.com`, display_name: t.who },
    organization: { uuid: t.org || 'org-1', name: t.org_name || t.org || 'org-1' },
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'port'), String(srv.address().port)));
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
