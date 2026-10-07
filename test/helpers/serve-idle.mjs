#!/usr/bin/env node
// test/helpers/serve-idle.mjs — the session token is an IDLE window, measured on a real daemon.
//
//     node test/helpers/serve-idle.mjs <base> slide <enrolment-code>     (session_ttl = 3)
//     node test/helpers/serve-idle.mjs <base> mint  <enrolment-code>     (prints the token)
//
// One "name <US> want <US> got" row per check for `slide`; test/run.sh does the comparing.
//
// THE BUG: mintSession() set exp = now + session_ttl and nothing ever moved it, so the
// owner was locked out fifteen minutes after Face ID while using the app — serve.log shows a
// 401 on /api/grid straight after a run of 200s. The rows below put requests ONE SECOND
// apart against a THREE-second ttl, so the token is alive at t+3 and t+4 only if each
// request moved its deadline: with the slide removed the t+3 row is a 401, deterministically —
// exp is floor(mint)+3 and floor(t+3) has always reached it. Then it sits idle past the
// window and must die, or "sliding" would have quietly become "never expires".
//   THREE, NOT TWO. The server's clock is whole seconds, so a slid deadline is
// floor(request)+ttl. Against a two-second ttl a request at x.99 s set exp to x+2, and the
// next one, due at x+1.99, met it if it was 10 ms late: on a loaded runner a 401 on the
// third read of a session that was being used every second, with nothing wrong. A third
// second gives each read a full second of scheduling slack and changes nothing else.
import { Authenticator, request } from './serve-client.mjs';

const US = '\x1f';
const [base, phase, code] = process.argv.slice(2);
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const a = new Authenticator({ rpId: new URL(base).hostname, origin: base });

const enrol = await a.enroll(base, code);
if (!enrol.json || !enrol.json.token) {
  console.log(`enrolled${US}200${US}${JSON.stringify(enrol.status)}`);
  process.exit(0);
}
if (phase === 'mint') { console.log(a.token); process.exit(0); }

const read = () => request(base, 'GET', '/api/projects', { headers: { authorization: `Bearer ${a.token}` } });
const born = Date.now(), minted = enrol.json.expires_at;
const statuses = [];
for (let i = 1; i <= 4; i++) {
  await sleep(born + i * 1000 - Date.now());
  statuses.push((await read()).status);
}
is('used every second, it lives past its ttl', '200 200 200 200', statuses.join(' '));
is('...for longer than the ttl from Face ID', true, Date.now() - born >= 4000);
// The header the client mirrors (web/api.js slid()). Asked on a separate read so the row
// says what the CLIENT would see, not what the loop above happened to throw away.
const h = await new Promise((resolve) => {
  const u = new URL('/api/projects', base);
  import('node:http').then(({ default: http }) => {
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${a.token}` } },
      (res) => { res.resume(); resolve(Number(res.headers['x-session-expires'])); });
  });
});
is('the server tells the client its new deadline', true, Number.isFinite(h) && h > minted);
// Idle: no request for ttl + 1 (the +1 absorbs the server's whole-second clock).
await sleep(4200);
is('left idle past the ttl, it is refused', 401, (await read()).status);
is('...and it stays dead (a 401 does not revive it)', 401, (await read()).status);
console.log(rows.join('\n'));
