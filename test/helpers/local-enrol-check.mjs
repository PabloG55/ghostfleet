#!/usr/bin/env node
// test/helpers/local-enrol-check.mjs — the Mac enrols its own passkey at http://localhost,
// in a real browser, through the lock's own enrolment field (web/src/lock.jsx).
//
//     node test/helpers/local-enrol-check.mjs <fleet-serve.mjs> <port> <client-id>
//
// Run with the daemon's own HOME and GHOSTFLEET_SERVE_CONFIG: it opens the enrolment window
// with `fleet-serve enroll` and reads the config afterwards to see what was stored.
// One "name <US> want <US> got" row per check, or a #SKIP row when there is no Chrome.
//
// Touch ID IS A VIRTUAL AUTHENTICATOR. CDP's WebAuthn domain gives the page a platform
// authenticator (internal transport, user verification, resident keys) that answers
// navigator.credentials itself, so what runs is web/passkey.js's own ceremony, the
// browser's own clientDataJSON for origin http://localhost:<port>, and fleet-serve's own
// checks. Nothing on the wire is built by this file. That is the point: serve-local.mjs
// proves the server's rules with a synthetic authenticator, and this proves a browser at
// localhost satisfies them. Those two can disagree, on the origin string the browser
// writes, the rp id it signs and whether http://localhost counts as a secure context.
//
// `localhost` IS MAPPED TO 127.0.0.1. The suite's stand-in for the tailnet bind is ::1,
// and a browser that tried ::1 first would land on the other listener. The owner's Mac has
// nothing on ::1, so its browser falls back to 127.0.0.1 on its own. The page's origin, and
// with it the secure context and the rp id, are decided by the URL's name, not by the
// address it resolved to, so the mapping changes nothing the test is about.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, sleep } from '../../lib/browser.mjs';

const [serveJs, port, clientId = 'mac'] = process.argv.slice(2);
const URL_ = `http://localhost:${port}/`;
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

let b;
try {
  b = await launch({ width: 430, height: 900, scale: 1, mobile: false,
    args: ['--host-resolver-rules=MAP localhost 127.0.0.1'] });
} catch (e) {
  if (/no chrome/i.test(String(e && e.message))) { rows.push('#SKIP' + US + 'localhost enrolment in a browser' + US + 'no chrome'); done(0); }
  throw e;
}
async function until(cond, ms = 10000) {
  const t0 = Date.now();
  let v = await cond();
  while (!v && Date.now() - t0 < ms) { await sleep(100); v = await cond(); }
  return v;
}
// Buttons are matched by their label, as somebody looking at the screen would find them.
const click = (label) => b.evaluate((l) => {
  const x = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === l);
  if (!x || x.disabled) return false;
  x.click(); return true;
}, label);
// LOCKED IS THE LOCK CARD, and IN is the app's sidebar. Both are asked: between a reload and
// the first paint neither is drawn, and "no lock card" alone read that blank moment as a way in.
const page = () => b.evaluate(() => ({
  locked: !!document.querySelector('.auth-card'),
  in: !document.querySelector('.auth-card') && !!document.querySelector('nav.side'),
  buttons: [...document.querySelectorAll('button')].map(e => e.textContent.trim()).filter(Boolean),
  card: ((document.querySelector('.auth-card') || {}).textContent || '').trim(),
  err: ((document.querySelector('.auth-card .err') || {}).textContent || '').trim(),
  secure: window.isSecureContext,
  origin: location.origin,
}));
const CODE_FIELD = '.auth-card input[autocomplete="one-time-code"]';

try {
  await b.call('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await b.call('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  // THE WORDS NAME THE DEVICE. The platform is set explicitly, because a dev Mac's Chrome
  // reports MacIntel and a runner's reports Linux, and each direction has to be seen on
  // both. A phone keeps "this phone", a desktop Mac is "this Mac" with Touch ID, and an
  // iPad (MacIntel with touch points) is not mistaken for a Mac.
  const ua = await b.evaluate(() => navigator.userAgent);
  const as = async (platform, touch) => {
    await b.call('Emulation.setUserAgentOverride', { userAgent: ua, platform });
    await b.call('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await b.call('Page.navigate', { url: URL_ });
    await until(async () => (await page()).buttons.some(x => /^enrol /i.test(x)));
    return (await page()).buttons.find(x => /^enrol /i.test(x)) || '(no enrol button)';
  };
  is('a phone is offered "Enrol this phone"', 'Enrol this phone', await as('iPhone', true));
  is('an iPad is not mistaken for a Mac', 'Enrol this phone', await as('MacIntel', true));
  const enrolLabel = await as('MacIntel', false);
  const p0 = await page();
  is('the page at localhost is a secure context', true, p0.secure);
  is('...whose origin is http://localhost:<port>', `http://localhost:${port}`, p0.origin);
  is('a Mac with no passkey is offered "Enrol this Mac"', 'Enrol this Mac', enrolLabel);
  // With no window open, the card says where to open one. It asks the server before anything
  // is typed, so the sentence arrives a moment after the button does.
  is('...and the card says where to run the command', true,
     !!(await until(async () => /In a terminal on this Mac: fleet-serve enroll mac/.test((await page()).card))));

  const code = (execFileSync(process.execPath, [serveJs, 'enroll', clientId], { encoding: 'utf8' })
    .match(/[A-Z0-9]{5}-[A-Z0-9]{5}/) || [''])[0];
  is('fleet-serve opened an enrolment window', true, !!code);
  // The card asks once per open, so the window it can see is the one open when it was drawn.
  await b.call('Page.reload', {});
  is('...and a card drawn after it says the window is open', true,
     !!(await until(async () => /An enrolment window is open for mac/.test((await page()).card))));
  // Typed the way a person types it: into the card's code field, then its button.
  await until(() => b.evaluate((s) => !!document.querySelector(s), CODE_FIELD));
  await b.evaluate((c, s) => {
    const i = document.querySelector(s);
    i.value = c; i.dispatchEvent(new Event('input', { bubbles: true }));
  }, code, CODE_FIELD);
  await until(() => click('Enrol this Mac'));
  const unlocked = await until(async () => (await page()).in);
  const p1 = await page();
  is('the code field enrols the Mac and unlocks it', true, unlocked || p1.err || p1.buttons.join(', '));

  // What the server stored: a localhost passkey, on the client the window was opened for.
  const cfg = JSON.parse(fs.readFileSync(process.env.GHOSTFLEET_SERVE_CONFIG, 'utf8'));
  const cl = (cfg.clients || []).find(x => x.id === clientId);
  is('the server enrolled the passkey', 1, cl ? (cl.creds || []).length : 0);
  is('...as a localhost passkey', 'localhost', cl && cl.creds && cl.creds[0] && cl.creds[0].rp_id);
  const cred = await b.call('WebAuthn.getCredentials', { authenticatorId });
  is('the authenticator holds one credential, for rp localhost', 'localhost',
     (cred.credentials || []).map(x => x.rpId).join(',') || 'none');

  // A COLD OPEN: no session, the passkey on the device. The way in is Touch ID, not the
  // enrolment sheet again, and it signs in against the same listener.
  //   THE LOCK SCREEN CANNOT BE WATCHED FOR. The app makes its one automatic attempt on open,
  // and a virtual authenticator answers it before the first poll: on both CI runners the
  // page was already unlocked when it was first read, and "locked again" went red on a
  // client that was right. So the cold open is proved by what it cost: the session the page
  // held is gone, the authenticator signed one more time, and the page holds a NEW token.
  const signs = async () => ((await b.call('WebAuthn.getCredentials', { authenticatorId })).credentials || [])
    .reduce((n, x) => n + (x.signCount || 0), 0);
  const tokens = () => b.evaluate(() => Object.keys(sessionStorage).sort().map(k => sessionStorage.getItem(k)).join('|'));
  const before = { signs: await signs(), tok: await tokens() };
  await b.evaluate(() => { sessionStorage.clear(); });
  await b.call('Page.reload', {});
  // The app may make its one automatic attempt on open; otherwise the button is the way.
  let in2 = await until(async () => (await page()).in && (await tokens()) !== '', 3000);
  if (!in2) {
    const p = await page();
    const unlockLabel = p.buttons.find(x => /^unlock with /i.test(x));
    if (unlockLabel) await click(unlockLabel);
    in2 = await until(async () => (await page()).in && (await tokens()) !== '');
  }
  const p2 = await page();
  is('a cold open asks the passkey again', true, (await signs()) > before.signs || `signCount ${before.signs} -> ${await signs()}`);
  is('...and is let in on a new token', true, ((await tokens()) !== '' && (await tokens()) !== before.tok) || 'same or no token');
  is('...and the passkey unlocks it', true, in2 || p2.err || p2.buttons.join(', '));
  // The sensor the unlock button names, asked of the function the label is built from:
  // the button usually reads "unlocking…" by the time it could be read, for the reason above.
  is('...and the sensor it names is Touch ID', 'Touch ID', await b.evaluate(async () =>
    (await import('./passkey.js')).device().sensor));
  const cfg2 = JSON.parse(fs.readFileSync(process.env.GHOSTFLEET_SERVE_CONFIG, 'utf8'));
  is('...without enrolling a second one', 1, ((cfg2.clients || []).find(x => x.id === clientId)?.creds || []).length);
} finally {
  await b.close();
}
done(0);
