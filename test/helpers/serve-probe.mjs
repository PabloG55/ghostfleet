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
import fs from 'node:fs';
import { Authenticator, request } from './serve-client.mjs';

const US = '\x1f';
const [base, phase, arg] = process.argv.slice(2);
const row = (name, r) => console.log(`${name}${US}${r.status}${US}${JSON.stringify(r.json)}`);
const a = new Authenticator({ rpId: new URL(base).hostname, origin: base });

// ── attachments: bytes on the fleet's disk ────────────────────────────────
// The first route in ghostfleet that writes externally-supplied bytes anywhere, so most of
// what is asked here is refusals. Both directions on every one: a server that said no to
// everything would pass a file of "is it refused?" rows and be useless.
if (phase === 'attach') {
  const enrol = await a.enroll(base, arg);
  if (!enrol.json || !enrol.json.token) { row('attach.enrol', enrol); process.exit(0); }
  // A 1x1 PNG and a 1x1 JPEG, written out as bytes rather than fetched from anywhere.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20), Buffer.from([0xff, 0xd9])]);
  const post = (body) => a.api(base, 'POST', '/api/attach', body);
  const b64 = (b) => b.toString('base64');

  // AUTH FIRST, because this route changes the filesystem: no live token, no request.
  row('attach.noToken', await request(base, 'POST', '/api/attach',
    { body: { project: 'demo', session: 'w', data: b64(PNG) } }));
  // ...and the same body WITH one, or the row above proves only that the server says no.
  row('attach.png', await post({ project: 'demo', session: 'attachtest', data: b64(PNG) }));
  row('attach.jpg', await post({ project: 'demo', session: 'attachtest', data: b64(JPG) }));

  // SNIFFED, NOT DECLARED. An SVG is refused by name because it is an image that is also a
  // script container; anything else unrecognised is refused as not-an-image.
  row('attach.svg', await post({ project: 'demo', session: 'attachtest',
    data: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')) }));
  row('attach.junk', await post({ project: 'demo', session: 'attachtest',
    data: b64(Buffer.from('this is a text file wearing a photo hat, at some length')) }));
  row('attach.empty', await post({ project: 'demo', session: 'attachtest', data: '' }));

  // THE SESSION NAME IS A PATH COMPONENT AND COMES FROM A PHONE. Traversal is refused by
  // shape rather than sanitised away, and the refusal names what is allowed.
  row('attach.traversal', await post({ project: 'demo', session: '../../../../etc/x', data: b64(PNG) }));
  row('attach.slash', await post({ project: 'demo', session: 'a/b', data: b64(PNG) }));
  row('attach.dots', await post({ project: 'demo', session: '..', data: b64(PNG) }));
  row('attach.emptySession', await post({ project: 'demo', session: '', data: b64(PNG) }));
  row('attach.badProject', await post({ project: 'nope', session: 'attachtest', data: b64(PNG) }));

  // TWO CEILINGS, AND THEY ARE DIFFERENT CHECKS. The decoded limit is 6 MB and the body cap
  // is 9 MB, and the gap between them is deliberate: base64 inflates by a third, so 6 MB of
  // photo is 8 MB of body and a cap set AT 8 would make the decoded check unreachable —
  // every oversized photo would die on the body instead, and the message that names the
  // photo's size would never be seen. Measured that way round the first time.
  const big = Buffer.concat([PNG, Buffer.alloc(6.5 * 1024 * 1024, 0x41)]);   // ~8.7 MB of body
  row('attach.tooBig', await post({ project: 'demo', session: 'attachtest', data: b64(big) }));
  // ...and past the body cap, which fires while the bytes are still arriving.
  const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024, 0x41)]);
  row('attach.pastCap', await post({ project: 'demo', session: 'attachtest', data: b64(huge) }));
  process.exit(0);
}

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

// PUSH (docs/mobile.md §9). One phase, because the whole property is a SEQUENCE across
// the daemon's own scan: subscribe, let a session transition, and see what the fake push
// service was handed. The steps that have to happen between requests — writing a status
// file, polling to look busy — belong to the shell, so this phase does the parts that
// need a passkey and prints the token for the rest.
//
//     node serve-probe.mjs <base> push <enrol-code> <subscription-file>
if (phase === 'push') {
  const sub = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'));
  await a.enroll(base, arg);
  console.log(`token${US}0${US}${JSON.stringify({ token: a.token, cred: a.credentialId })}`);
  // The subscription endpoint is a URL the daemon will POST to, so it is validated like
  // one. Both directions: the shapes that must be refused, and then the real one.
  row('key', await a.api(base, 'GET', '/api/push/key'));
  row('subscribe.noKeys', await a.api(base, 'POST', '/api/push/subscribe', { endpoint: sub.endpoint }));
  row('subscribe.httpEndpoint', await a.api(base, 'POST', '/api/push/subscribe', { endpoint: 'http://evil.example/x', keys: sub.keys }));
  row('subscribe.shortAuth', await a.api(base, 'POST', '/api/push/subscribe', { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: 'AAAA' } }));
  row('subscribe.ok', await a.api(base, 'POST', '/api/push/subscribe', sub));
  // ...and with no token at all, which is the control that matters: a subscription
  // receives fleet state, so it must be exactly as hard to take out as a read.
  row('subscribe.noToken', await request(base, 'POST', '/api/push/subscribe', { body: sub }));
  row('key.after', await a.api(base, 'GET', '/api/push/key'));
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

  // THE LEAD IS NOT A WORKER. It only became nameable from here when it gained a card
  // (docs/mobile.md §4), and `reclaim` on it would aim fleet-clean at the repo's own main
  // checkout. Every one of these carries a REAL assertion, so what is being shown is the
  // refusal itself and not a missing fingerprint — and they are LAST so the force chain
  // above keeps the sequence it is asserting on. run.sh checks the other half: the stubs
  // record every command that ran, and neither fleet-stop nor fleet-rename is among them.
  row('lead.stop', await a.verb(base, 'fleet_stop', { project: 'demo', session: 'master' }, await fresh('stop')));
  row('lead.reclaim', await a.verb(base, 'fleet_stop', { project: 'demo', session: 'master', reclaim: true }, await fresh('stop')));
  row('lead.rename', await a.verb(base, 'fleet_rename', { project: 'demo', session: 'master', new_name: 'lead' }, await fresh('rename')));
  // ...and the other direction on the guard itself: a session whose name merely CONTAINS
  // it is an ordinary worker. A prefix match here would refuse real sessions.
  row('nearLead.stop', await a.verb(base, 'fleet_stop', { project: 'demo', session: 'master-card' }, await fresh('stop')));

  // PARK is a worker verb too — bin/fleet-governor already excludes master from what it
  // parks, because a fleet whose lead is off dispatches nothing. It needs no passkey, so
  // these carry none: what is being shown is the planner's refusal, not the gate's.
  row('lead.pause', await a.verb(base, 'fleet_pause', { project: 'demo', session: 'master' }));
  // ...and RESUME is deliberately NOT refused. The recovery direction has to stay open, or
  // a lead parked by an older build could never be turned back on from the phone — and an
  // asymmetry nothing tests is an asymmetry that gets 'tidied up' into a bug.
  row('lead.resume', await a.verb(base, 'fleet_resume', { project: 'demo', session: 'master' }));
  row('worker.pause', await a.verb(base, 'fleet_pause', { project: 'demo', session: 'w1' }));
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

// THE PAYOFF PATH, in one phase because the whole value is the CHAIN. docs/mobile.md §7
// put `answer keys` on the session screen from the start, and it was close to useless: a
// worker blocked on "Allow pnpm test?" since 9pm is exactly the case the app exists for,
// and you could not see what you were answering. So: the pane shows a real permission
// dialog, the verb clears it, and the pane changes. Any one of the three alone proves
// nothing — a pane that never changes and a verb that does nothing look the same.
//
// Real tmux on the far side (run.sh creates the session), and the REAL bin/fleet-answer,
// not the stub the other phases use. What the pane contains is the genuine bytes Claude
// Code emitted for a "Do you want to create hello.txt?" prompt, captured live and replayed
// into a pane that then blocks on a keystroke — so the escapes are Claude's own while the
// key handling stays deterministic enough for a suite.
if (phase === 'pane') {
  await a.enroll(base, arg);
  row('pane.dialog', await a.api(base, 'GET', '/api/pane?project=demo&session=dlg'));
  // The same session NAME on another fleet. run.sh puts an unmistakable decoy there,
  // because a pane read that ignored the socket would return a plausible screenful of
  // somebody else's work rather than an error — CLAUDE.md's most-repeated scar.
  row('pane.otherFleet', await a.api(base, 'GET', '/api/pane?project=other&session=dlg'));
  row('pane.answer', await a.verb(base, 'fleet_answer', { project: 'demo', session: 'dlg', text: '1' }));
  // The pane is read again only after the far side has had a moment to redraw. Polled, not
  // slept: a fixed sleep tuned to this machine is a test that passes on this machine.
  let after = null;
  for (let i = 0; i < 60; i++) {
    after = await a.api(base, 'GET', '/api/pane?project=demo&session=dlg');
    if (!String(after.json?.pane || '').includes('Do you want to create')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  row('pane.after', after);
  // The argument checks and the geometry, on the same server: a missing session, a
  // scrollback out of range, and a scrollback that is allowed.
  row('pane.noSession', await a.api(base, 'GET', '/api/pane?project=demo'));
  row('pane.noProject', await a.api(base, 'GET', '/api/pane?session=dlg'));
  row('pane.badProject', await a.api(base, 'GET', '/api/pane?project=nope&session=dlg'));
  row('pane.gone', await a.api(base, 'GET', '/api/pane?project=demo&session=no-such-session'));
  row('pane.scrollbackBad', await a.api(base, 'GET', '/api/pane?project=demo&session=dlg&scrollback=99999'));
  row('pane.scrollbackNeg', await a.api(base, 'GET', '/api/pane?project=demo&session=dlg&scrollback=-1'));
  row('pane.scrollbackOk', await a.api(base, 'GET', '/api/pane?project=demo&session=dlg&scrollback=50'));
  // ...and a cold read of it is refused like every other read (§5): the pane is a READ
  // behind the same session-token gate, with no auth path of its own.
  row('pane.noToken', await request(base, 'GET', '/api/pane?project=demo&session=dlg'));
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
