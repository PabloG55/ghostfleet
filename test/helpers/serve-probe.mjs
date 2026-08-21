// test/helpers/serve-probe.mjs — drives a running bin/fleet-serve and prints one
// \x1f-separated row per probe, so the bash suite can assert on statuses and bodies
// without re-implementing WebAuthn in shell.
//
//     node serve-probe.mjs <base-url> <phase> [enrol-code]
//     node serve-probe.mjs <base-url> revoked <token>
//
// Phases exist because two properties can only be shown ACROSS a change made from
// outside the process: `revoked` needs `fleet-serve revoke` to run between two requests,
// and the rate phase needs a config the others must not have. One server, several phases.
//
// Output:  <name>\x1f<http status>\x1f<json body on one line>
import { Authenticator, request } from './serve-client.mjs';

const US = '\x1f';
const [base, phase, arg] = process.argv.slice(2);
const row = (name, r) => console.log(`${name}${US}${r.status}${US}${JSON.stringify(r.json)}`);
const a = new Authenticator({ rpId: new URL(base).hostname, origin: base });

if (phase === 'auth') {
  // Before anything is enrolled and before any token exists.
  row('cold.read', await request(base, 'GET', '/api/projects'));
  row('cold.verb', await request(base, 'POST', '/api/verb', { body: { tool: 'fleet_list', args: { project: 'demo' } } }));
  // A challenge is free to ask for — it is what a cold open needs — but it buys nothing.
  row('cold.challenge', await request(base, 'GET', '/api/auth/challenge'));

  // §1: registration with no authorisation would let anyone who reaches the port enrol
  // their own passkey and be inside. The contract as written has no gate; this server
  // requires the window AND the code, and refuses each missing half by name.
  row('register.noCode', await request(base, 'POST', '/api/auth/register', { body: { id: a.credentialId, attestation: 'x', client_data: 'y' } }));
  row('register.wrongCode', await a.enroll(base, 'ZZZZZ-ZZZZZ'));
  row('register.ok', await a.enroll(base, arg));
  console.log(`token${US}0${US}${JSON.stringify({ token: a.token, cred: a.credentialId })}`);

  // THE §5 PROPERTY. There is one token and only a verified assertion mints it, so the
  // request that must fail is the one carrying anything else — including the credential
  // id, which web/passkey.js keeps in localStorage and is careful to call not-a-secret.
  row('noToken.read', await request(base, 'GET', '/api/projects'));
  row('forgedToken.read', await request(base, 'GET', '/api/projects', { headers: { authorization: 'Bearer not-a-real-token' } }));
  row('credAsToken.read', await request(base, 'GET', '/api/projects', { headers: { authorization: `Bearer ${a.credentialId}` } }));
  // ...and the other direction, or a server that refused everything would look identical.
  row('token.read', await a.api(base, 'GET', '/api/projects'));
  row('token.verb', await a.verb(base, 'fleet_list', { project: 'demo' }));

  // A forged assertion must not mint one.
  row('assert.ok', await a.assert(base));
  row('assert.replay', await a.assert(base, { tamper: { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }));
  row('assert.noPresence', await a.assert(base, { tamper: { flags: 0x00 } }));
  row('assert.badSig', await a.assert(base, { tamper: { signature: Buffer.alloc(70) } }));
  const b = new Authenticator({ rpId: new URL(base).hostname, origin: base });
  row('assert.strangeKey', await b.assert(base));
  // A challenge is single-use: signing the same one twice is a replay.
  const reuse = await request(base, 'GET', '/api/auth/challenge');
  const once = { id: a.credentialId, purpose: 'open', ...(() => {
    const cd = a.clientData('webauthn.get', reuse.json.challenge);
    const ad = a.authData({});
    return { client_data: Buffer.from(cd).toString('base64url'),
             authenticator_data: Buffer.from(ad).toString('base64url'),
             signature: Buffer.from(a.sign(ad, cd)).toString('base64url') };
  })() };
  row('assert.firstUse', await request(base, 'POST', '/api/auth/assert', { body: once }));
  row('assert.secondUse', await request(base, 'POST', '/api/auth/assert', { body: once }));

  row('host.wrong', await request(base, 'GET', '/api/projects', { headers: { ...a.headers(), host: 'evil.example' } }));
  row('origin.wrong', await request(base, 'POST', '/api/verb', { headers: { ...a.headers(), origin: 'https://evil.example' }, body: { tool: 'fleet_list', args: { project: 'demo' } } }));
}

if (phase === 'verbs') {
  await a.enroll(base, arg);
  const fresh = (purpose) => a.fresh(base, purpose);

  row('project.missing', await a.verb(base, 'fleet_list', {}));
  row('project.unknown', await a.verb(base, 'fleet_list', { project: 'nope' }));
  row('arg.typo', await a.verb(base, 'fleet_send', { project: 'demo', session: 'w1', promt: 'x' }));
  row('arg.missing', await a.verb(base, 'fleet_send', { project: 'demo', session: 'w1' }));
  row('tool.unknown', await a.verb(base, 'rm -rf', { project: 'demo' }));
  // The eight the client asks for that have no MCP tool: two now exist, six are refused
  // by NAME with the reason, so the buttons behind them fail loudly.
  row('tool.notYet', await a.verb(base, 'fleet_label', { project: 'demo', session: 'w1', label: 'x' }));
  row('send.ok', await a.verb(base, 'fleet_send', { project: 'demo', session: 'w1', prompt: 'the real work' }));
  // The same verb aimed at ANOTHER project, from the same daemon process: the child's
  // scope/root/socket have to be that project's, not whichever one was asked for first.
  row('send.other', await a.verb(base, 'fleet_send', { project: 'other', session: 'o1', prompt: 'over there' }));
  row('answer.ok', await a.verb(base, 'fleet_answer', { project: 'demo', session: 'w1', text: '2' }));

  // Destructive: a fresh assertion at the moment of action, enforced on the tool name.
  row('spawn.noAssertion', await a.verb(base, 'fleet_spawn', { project: 'demo', name: 'api-9' }));
  row('spawn.badAssertion', await a.verb(base, 'fleet_spawn', { project: 'demo', name: 'api-9' },
      { ...(await fresh('spawn')), signature: Buffer.alloc(70).toString('base64url') }));
  row('spawn.ok', await a.verb(base, 'fleet_spawn', { project: 'demo', name: 'api-9' }, await fresh('spawn')));
  row('rename.ok', await a.verb(base, 'fleet_rename', { project: 'demo', session: 'w1', new_name: 'w2' }, await fresh('rename')));
  // Stricter than web/api.js's DESTRUCTIVE set, on purpose: these two arrive unsigned
  // from that client and are refused, naming why.
  row('wtRemove.noAssertion', await a.verb(base, 'fleet_worktree_remove', { project: 'demo', path: '/x/api-6' }));
  row('projectAdd.noAssertion', await a.verb(base, 'fleet_project_add', { path: '/tmp' }));
  // An assertion signed by ANOTHER enrolled client is not this session's confirmation.
  const other = new Authenticator({ rpId: new URL(base).hostname, origin: base });
  other._base = base;
  row('spawn.othersAssertion', await a.verb(base, 'fleet_spawn', { project: 'demo', name: 'api-X' }, await other.signChallenge({ purpose: 'spawn' })));

  // `f = remove anyway` — its own step, after a refusal it is answering, and one refusal
  // buys exactly one force.
  row('force.beforeRefusal', await a.verb(base, 'fleet_worktree_remove', { project: 'demo', path: '/x/api-6', force: true }, await fresh('force')));
  row('remove.declined', await a.verb(base, 'fleet_worktree_remove', { project: 'demo', path: '/x/api-6' }, await fresh('remove')));
  row('force.ok', await a.verb(base, 'fleet_worktree_remove', { project: 'demo', path: '/x/api-6', force: true }, await fresh('force')));
  row('force.twice', await a.verb(base, 'fleet_worktree_remove', { project: 'demo', path: '/x/api-6', force: true }, await fresh('force')));
  // the same two-step on a session's own worktree
  row('reclaim.declined', await a.verb(base, 'fleet_stop', { project: 'demo', session: 'w1', reclaim: true }, await fresh('stop')));
  row('reclaimForce.ok', await a.verb(base, 'fleet_stop', { project: 'demo', session: 'w1', reclaim: true, force: true }, await fresh('force')));
}

if (phase === 'reads') {
  await a.enroll(base, arg);
  row('grid', await a.api(base, 'GET', '/api/grid?project=demo'));
  row('grid.other', await a.api(base, 'GET', '/api/grid?project=other'));
  row('grid.unknown', await a.api(base, 'GET', '/api/grid?project=nope'));
  row('session', await a.api(base, 'GET', '/api/session?project=demo&session=w1'));
  row('session.limit', await a.api(base, 'GET', '/api/session?project=demo&session=w1&limit=5'));
  row('session.zero', await a.api(base, 'GET', '/api/session?project=demo&session=w1&limit=0'));
  row('session.huge', await a.api(base, 'GET', '/api/session?project=demo&session=w1&limit=99999'));
  row('checkouts', await a.api(base, 'GET', '/api/checkouts?project=demo'));
  row('settings', await a.api(base, 'GET', '/api/settings?project=demo'));
  row('projects', await a.api(base, 'GET', '/api/projects'));
  row('inbox', await a.api(base, 'GET', '/api/inbox?project=demo'));
  row('audit', await a.api(base, 'GET', '/api/audit?limit=5'));
  row('health', await a.api(base, 'GET', '/api/health'));
}

if (phase === 'rate') {
  await a.enroll(base, arg);
  const seen = [];
  for (let i = 0; i < 8; i++) seen.push((await a.api(base, 'GET', '/api/projects')).status);
  console.log(`burst${US}0${US}${JSON.stringify(seen)}`);
}

// Phase two of revocation: the token minted before `fleet-serve revoke` ran, replayed
// after it — and the passkey that minted it, trying for another.
if (phase === 'revoked') {
  row('revoked.read', await request(base, 'GET', '/api/projects', { headers: { authorization: `Bearer ${arg}` } }));
  row('revoked.verb', await request(base, 'POST', '/api/verb', { headers: { authorization: `Bearer ${arg}` }, body: { tool: 'fleet_list', args: { project: 'demo' } } }));
  const cred = process.argv[5];
  if (cred) {
    const ghost = new Authenticator({ rpId: new URL(base).hostname, origin: base });
    ghost.credId = Buffer.from(cred, 'base64url');
    row('revoked.assert', await ghost.assert(base));
  }
}
