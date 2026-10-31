#!/usr/bin/env node
// test/helpers/term-check.mjs — the web terminal in a real browser, against a real
// fleet-serve and the suite's own tmux server.
//
//     node test/helpers/term-check.mjs <base> <enrolment-code> <project> <sock> <serve-log> <repo>
//
// One "name <US> want <US> got" row per check; test/run.sh does the comparing.
//
// THE PASSKEY IS REAL CEREMONY, NOT A STUB. The probe enrols a key pair through the server's
// own register endpoint (serve-client.mjs), and the same private key is then installed in
// Chrome's virtual authenticator (CDP WebAuthn) — so web/passkey.js runs its real
// navigator.credentials.get(), Chrome signs a real challenge the server issued, and the
// server verifies it. That is what lets "the terminal opens only after the passkey step" be
// asserted in both directions: the authenticator is told to refuse user verification, the
// terminal must not open, and nothing must have been asked of tmux; then it is told to
// allow it, and the terminal must open.
//
// What it cannot be is an iPhone: the on-screen keyboard is CDP's Input.insertText and a
// touch is CDP's touch emulation. The PR says which halves that leaves unchecked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch, sleep } from '../../lib/browser.mjs';
import { Authenticator } from './serve-client.mjs';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
let browser = null;
const done = async (code = 0) => { try { if (browser) await browser.close(); } catch {} console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', async (e) => { console.error(String(e && e.stack || e)); await done(1); });
process.on('unhandledRejection', async (e) => { console.error(String(e && e.stack || e)); await done(1); });

const [BASE0, CODE, PROJECT = 'demo', SOCK = 'cf-demo', LOG = '', REPO = ''] = process.argv.slice(2);
const BASE = (BASE0 || '').replace(/\/+$/, '');
const U = new URL(BASE);
const TAB = `_term-${PROJECT}`;
const tmux = (...a) => { try { return execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const hasTab = () => { try { execFileSync('tmux', ['-L', SOCK, 'has-session', '-t', `=${TAB}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const capture = () => tmux('capture-pane', '-p', '-t', TAB);
const controlClients = () => tmux('list-clients', '-t', TAB, '-F', '#{client_control_mode}').split('\n').filter(x => x === '1').length;
const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v || Date.now() > end) return v; await sleep(step); }
}
const hasNvim = (() => { try { execFileSync('nvim', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// ── enrol, then hand the same key to Chrome ───────────────────────────────────────
const a = new Authenticator({ rpId: U.hostname, origin: U.origin });
const reg = await a.enroll(BASE, CODE);
is('term-ui: the device enrolled', 200, reg.status);

// ONE CHROME PER DEVICE: the phone, then a desk. Not one browser whose touch emulation is
// switched off half way: on a Linux runner, which has no pointing device at all, turning it
// off drops the page back to (pointer: none) and no hover — measured, the launch switch that
// declares a mouse is forgotten there (a Mac goes back to fine) — and the two panes, which
// ask for a fine pointer that hovers, never appeared. So the desk is launched as a desk,
// with the mouse declared as desktop-check.mjs does, and is handed the same passkey with
// the signature counter where the phone left it: the server refuses one that goes back.
const MOUSE = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
let call, evaluate, authenticatorId, signCount = a.counter;
async function device(phone) {
  if (browser) {
    const { credentials = [] } = await call('WebAuthn.getCredentials', { authenticatorId }).catch(() => ({}));
    if (credentials[0]) signCount = credentials[0].signCount;
    await browser.close(); browser = null;
  }
  try { browser = await launch(phone ? { width: 390, height: 844, scale: 2, mobile: true } : { width: 1280, height: 800, scale: 1, mobile: false, args: [MOUSE] }); }
  catch (e) { if (/no chrome/.test(String(e.message))) { skipGroup('the web terminal in a browser', 'no chrome'); await done(0); } throw e; }
  ({ call, evaluate } = browser);
  // The page's own failures, on stderr — run.sh shows the first lines of it under a red row.
  browser.onEvent((m, p) => {
    if (m === 'Runtime.exceptionThrown') console.error('page threw:', (p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text) || '').split('\n')[0]);
    if (m === 'Runtime.consoleAPICalled' && p.type === 'error') console.error('page console.error:', (p.args || []).map(x => x.value ?? x.description).join(' ').slice(0, 200));
  });
  if (phone) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('WebAuthn.enable', { enableUI: false });
  ({ authenticatorId } = await call('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } }));
  await call('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: a.credId.toString('base64'), isResidentCredential: false, rpId: U.hostname,
    privateKey: a.priv.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount } });
  // Every WebSocket the page constructs, and every click, counted before any script of the app runs.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__gfWs = 0;
    window.__gfClicks = 0;
    document.addEventListener('click', () => { window.__gfClicks++; }, true);
    const W = window.WebSocket;
    // ...and every binary frame it writes, one entry per send, so a row that fails over a
    // key can print the bytes and their write boundaries the page put on the socket.
    window.__gfSent = [];
    window.WebSocket = class extends W {
      constructor(...x) { super(...x); window.__gfWs++; }
      send(d) {
        if (typeof d !== 'string') window.__gfSent.push(Array.from(new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength), (b) => b.toString(16).padStart(2, '0')).join(''));
        if (window.__gfSent.length > 200) window.__gfSent.shift();
        return super.send(d);
      }
    };
    try { localStorage.setItem('gf.cred:${U.origin}', ${JSON.stringify(a.credentialId)}); } catch {}
  ` });
}
await device(true);
const userVerified = (v) => call('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: v });

const nav = async () => {
  await call('Page.navigate', { url: BASE + '/' });
  return until(() => evaluate(() => !!document.querySelector('#app .cards .card:not(.skel)') || !!document.querySelector('#side .cards .card:not(.skel)')), 15000);
};
// Clicking BY WORDS, the way a person finds a button. Real input events (CDP), at the
// centre of the element — a touch on the phone, a mouse at the desk — never el.click(),
// which would skip the pointerdown the key row listens to and the activation WebKit wants.
// NOT MID-SLIDE: a screen change runs a view transition (app.js slideNav) for 260ms, and a
// tap inside it lands on the transition's snapshot, not on the page — measured, the grid's
// ⋯ was tapped and nothing opened, on alternate runs.
const rectOf = (sel, text) => evaluate((sel, text) => {
  if (document.documentElement.dataset.nav) return null;
  const n = [...document.querySelectorAll(sel)].find(x => !text || (x.textContent || '').trim() === text || (x.textContent || '').includes(text));
  if (!n) return null;
  n.scrollIntoView({ block: 'nearest' });
  const r = n.getBoundingClientRect();
  return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}, sel, text);
let touching = true;
async function tap(sel, text) {
  const p = await until(() => rectOf(sel, text), 6000);
  if (!p) return false;
  const n0 = await evaluate(() => window.__gfClicks);
  if (touching) {
    // A touch pair, which Chrome turns into pointerdown, touchstart, touchend and click.
    // NOT Input.synthesizeTapGesture: on Linux headless Chrome it delivers the pointer and
    // touch events and never the click — measured, 0 clicks in 3 there against 3 in 3 on a
    // Mac — so on the Linux leg the ⋯ "opened" nothing and every row after it went red.
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  // Returns once the click has ARRIVED (a touch becomes one asynchronously), so a tap that
  // made none is red here, at the tap, instead of as the next thirty rows.
  const clicked = !!(await until(async () => (await evaluate(() => window.__gfClicks)) > n0, 3000));
  await sleep(150);
  return clicked;
}
// TERM_SHOTS=<dir>: a PNG at the moments worth looking at, for a human reviewing a change.
const shot = async (name) => {
  if (!process.env.TERM_SHOTS) return;
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${process.env.TERM_SHOTS}/${name}.png`, Buffer.from(data, 'base64'));
};
const KEYS = { Enter: [13, '\r'], Escape: [27, ''], Tab: [9, '\t'], Backquote: [192, '`'] };
async function key(k, mods = 0, text) {
  const [vk, t] = KEYS[k] || [k.toUpperCase().charCodeAt(0), k];
  const code = KEYS[k] ? k : /^[0-9]$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`;
  const keyName = k === 'Backquote' ? '`' : KEYS[k] ? k : k;
  const txt = text !== undefined ? text : (mods & 2 ? '' : t);
  await call('Input.dispatchKeyEvent', { type: txt ? 'keyDown' : 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers: mods, text: txt, unmodifiedText: txt });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
const CTRL = 2, SHIFT = 8;
const typeText = (s) => call('Input.insertText', { text: s });
const screenText = () => evaluate(() => [...document.querySelectorAll('.term-host .xterm-rows > div')].map(d => d.textContent).join('\n'));
const termGeom = () => evaluate(() => {
  const rowsEl = document.querySelectorAll('.term-host .xterm-rows > div');
  return rowsEl.length;
});
const focusedInTerm = () => evaluate(() => !!(document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')));
const termMsg = () => evaluate(() => { const m = document.querySelector('.term-screen .term-msg'); return m && !m.hidden ? m.textContent : ''; });
const wsCount = () => evaluate(() => window.__gfWs || 0);
// Counted from where THIS check began: the suite runs the probe against the same daemon first.
const opens = () => (logText().match(/POST \/api\/term\/open -> 200/g) || []).length;
const opens0 = opens();
const openCount = () => opens() - opens0;

// ══ PHONE, 390x844, touch ══════════════════════════════════════════════════════════
is('term-ui: the app unlocked with the passkey', true, !!(await nav()));
await tap('.cards .card', PROJECT);                                             // the project's grid
const grid = await until(() => evaluate((p) => !!document.querySelector('.hdr button.more') && (document.querySelector('.hdr .scope') || {}).textContent.includes(p), PROJECT), 8000);
is('term-ui: the project grid opened', true, !!grid);
async function openFromGrid() {
  await tap('.hdr button.more');
  return tap('.sheet button', 'terminal');
}

// ── 1. OFF FOR THIS DEVICE: the screen says so, and nothing was opened ──────────────
const fromGrid = await openFromGrid();
is('term-ui: the grid\'s actions offer the terminal', true, fromGrid);
const offMsg = await until(() => termMsg().then(t => /off for this device/.test(t) && t), 6000);
is('term-ui: a disabled device is told the terminal is off', true, !!offMsg);
await shot('phone-off');
is('...and no socket was opened', 0, await wsCount());
is('...and the server was never asked to open one', 0, openCount());
is('...and no tab exists on the fleet', false, hasTab());

// ── 2. switched on in settings, with the passkey ─────────────────────────────────────
await tap('.term-act button', 'settings');
await tap('.sheet button', 'turn the terminal on — passkey');
const onLine = await until(() => evaluate(() => { const p = document.querySelector('.sheet .term-set'); return p && /^on for this device/.test(p.textContent) && p.textContent; }), 8000);
is('term-ui: settings turned it on', true, !!onLine);
const cfgPath = process.env.GHOSTFLEET_SERVE_CONFIG || '';
const recorded = (() => { try { const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); return (c.clients.find(x => x.id === reg.json.client_id) || {}).terminal || null; } catch { return null; } })();
is('...and the server recorded it on THIS device\'s enrolment', true, !!(recorded && recorded.on && recorded.at > 0));
await tap('.sheet button', 'esc back');

// ── 3. ONLY AFTER THE PASSKEY STEP ───────────────────────────────────────────────────
await userVerified(false);
await tap('.term-act button', 'open the terminal — passkey');
const refused = await until(() => evaluate(() => { const b = document.querySelector('.term-act button'); return b && /open the terminal/.test(b.textContent); }), 8000);
await sleep(500);
is('term-ui: a passkey that does not verify opens nothing', true, !!refused);
is('...no socket', 0, await wsCount());
is('...no open request reached the server', 0, openCount());
is('...and no tab on the fleet', false, hasTab());
await userVerified(true);
await tap('.term-act button', 'open the terminal — passkey');
const opened = await until(() => evaluate(() => { const s = document.querySelector('.term-screen .term-host'); return s && !s.hidden && document.querySelectorAll('.term-host .xterm-rows > div').length > 0; }), 10000);
is('term-ui: with the passkey, the terminal opens', true, !!opened);
const prompt = await until(() => screenText().then(t => /\$ *$/m.test(t)), 8000);
is('...showing the shell', true, !!prompt);
// Counted once the shell is up: xterm is mounted while the open request is still in flight,
// so a count taken at "opened" reads 0 for a socket that is about to exist.
is('...on one socket', 1, await wsCount());
is('...on the project\'s tab', true, hasTab());

// ── 4. typed input reaches the pane ──────────────────────────────────────────────────
const MARK = `phone-${crypto.randomBytes(3).toString('hex')}`;
await tap('.term-host');
await typeText(`echo ${MARK}-$((6*7))`);
await key('Enter');
is('term-ui: typed on the phone, it reaches the pane (capture-pane)', true, !!(await until(() => capture().includes(`${MARK}-42`))));
is('...and the shell\'s answer is on the phone\'s screen', true, !!(await until(() => screenText().then(t => t.includes(`${MARK}-42`)))));

// ── 5. THE KEY ROW ───────────────────────────────────────────────────────────────────
const labels = await evaluate(() => [...document.querySelectorAll('.term-keys button')].map(b => b.textContent));
is('term-ui: the key row carries Esc, Ctrl, Tab, the arrows and | ~ / -', 'Esc Ctrl Tab ← ↑ ↓ → | ~ / -', labels.join(' '));
const rowVisible = await evaluate(() => { const r = document.querySelector('.term-keys'); return !!r && !r.hidden && r.getBoundingClientRect().height > 0; });
is('...and it is on screen', true, rowVisible);
// | from the row, inside a pipeline the shell then runs.
await typeText(`echo ${MARK}x `);
await tap('.term-keys button', '|');
await typeText(' tr x y');
await key('Enter');
is('term-ui: | from the key row is typed into the shell', true, !!(await until(() => capture().includes(`${MARK}y`))));
is('...and the tap left the focus in the terminal', true, await focusedInTerm());
// Ctrl latches, and changes the NEXT key: Ctrl then c interrupts a sleep.
await typeText('sleep 30; echo slept-through'); await key('Enter');
await sleep(300);
await tap('.term-keys button', 'Ctrl');
await typeText('c');
const interrupted = await until(() => { const c = capture(); return /\^C/.test(c) || /sleep 30; echo slept-through\n.*\$ *$/s.test(c); }, 5000);
is('term-ui: Ctrl then c is Ctrl-C (the sleep is interrupted)', true, !!interrupted);
is('...and the latch let go', false, await evaluate(() => { const b = [...document.querySelectorAll('.term-keys button')].find(x => x.textContent === 'Ctrl'); return !!b && b.classList.contains('on'); }));
// Tab, from the row, is a TAB BYTE in the pane — asked of od, not of completion: the suite's
// shell is /bin/sh, which is dash on the Linux leg and completes nothing.
await typeText('od -c'); await key('Enter');
await sleep(300);
await typeText('T'); await tap('.term-keys button', 'Tab'); await typeText('T'); await key('Enter');
await tap('.term-keys button', 'Ctrl'); await typeText('d');
is('term-ui: Tab from the key row reaches the pane as a tab', true, !!(await until(() => /T\s+\\t\s+T\s+\\n/.test(capture()))));

// ── 6. RESIZE PROPAGATES ─────────────────────────────────────────────────────────────
const winSize = () => tmux('display-message', '-p', '-t', TAB, '#{window_height}').trim();
const before = await termGeom();
is('term-ui: the tab is the size the phone draws', String(before), await until(() => winSize() === String(before) && winSize(), 5000) || winSize());
await browser.viewport(390, 560);
const after = await until(async () => { const g = await termGeom(); return g && g !== before && g; }, 5000);
is('term-ui: a shorter screen is fewer rows', true, !!after && after < before);
is('...and tmux follows it', String(after), await until(() => winSize() === String(after) && winSize(), 5000) || winSize());
await browser.viewport(390, 844);

// ── 7. NVIM, AND THE SCREEN IT DRAWS ────────────────────────────────────────────────
if (!hasNvim) skipGroup('nvim inside the web terminal', 'nvim is not installed');
else {
  const FILE = `nv-${MARK}.txt`;
  await typeText(`nvim --clean -n ${FILE}`); await key('Enter');
  const drawn = await until(() => screenText().then(t => t.split('\n').filter(l => /^~\s*$/.test(l)).length >= 5 && t), 10000);
  is('term-ui: nvim draws its screen in the browser (the ~ filler rows)', true, !!drawn);
  is('...with the file name on it', true, !!drawn && drawn.includes(FILE));
  await shot('phone-nvim');
  await typeText('ihello from nvim');
  // Each step once the last one is ON SCREEN, as a person would, and the Esc's own effect
  // looked for before `:wq` is typed. On the Linux runner the Esc once took no effect: nvim
  // stayed in insert mode and `:wq` became text. Not reproduced here — 40 runs recording the
  // pane's input had the bytes whole and in order, and nvim 0.9.5 leaves insert mode for an
  // ESC followed by `:` at any gap from 0 to 100ms — so when it happens again this says
  // whether the tap clicked and what the page wrote to the socket, write by write.
  await until(() => screenText().then(t => t.includes('hello from nvim') && t.includes('-- INSERT --')), 6000);
  const sent0 = await evaluate(() => window.__gfSent.length);
  const escTapped = await tap('.term-keys button', 'Esc');                // Esc from the key row
  if (!(await until(() => screenText().then(t => !t.includes('-- INSERT --')), 6000))) {
    console.error(`key-row Esc: clicked ${escTapped}, written since ${JSON.stringify(await evaluate((n) => window.__gfSent.slice(n), sent0))}, ` +
      `nvim's last line ${JSON.stringify(capture().split('\n').filter(Boolean).slice(-1)[0] || '')}`);
  }
  await typeText(':wq'); await key('Enter');
  const saved = await until(() => { try { return fs.readFileSync(`${REPO}/${FILE}`, 'utf8'); } catch { return ''; } }, 8000);
  is('term-ui: insert, Esc from the key row, :wq — and the file is written', 'hello from nvim\n', saved);
  is('...and the shell is back', true, !!(await until(() => screenText().then(t => /\$ *$/m.test(t) && !/^~\s*$/m.test(t)), 6000)));
}

// ── 8. A CLOSED SOCKET ENDS CLEANLY ─────────────────────────────────────────────────
await tap('.sbar button', '‹');
is('term-ui: back leaves the terminal screen', true, !!(await until(() => evaluate(() => !document.querySelector('.term-screen')), 5000)));
is('...the server says the browser closed it', true, !!(await until(() => /terminal closed: .* — closed by the browser/.test(logText()), 5000)));
is('...the control client is gone', 0, await until(() => controlClients() === 0 && 0, 5000) ?? controlClients());
is('...and the tab stays for the desk', true, hasTab());

// ══ DESKTOP, 1280x800, a mouse and a keyboard ══════════════════════════════════════
touching = false;
await device(false);
await nav();
// From Projects, whatever screen the app chose to open on.
await key('Escape'); await key('p', CTRL);
await sleep(600);
const duo = await until(() => evaluate(() => document.documentElement.classList.contains('duo')), 6000);
is('term-ui (desk): two panes', true, !!duo);
// The desk's way in: a project's DIGIT opens it on its master, and Ctrl-a t is the desk's
// terminal tab. The digit, not ⏎: ⏎ takes the project under the cursor, which is the first
// one listed — measured, with a second project listed first the terminal opened there.
const pos = await evaluate((p) => [...document.querySelectorAll('.cards .card:not(.skel)')].findIndex(c => (c.textContent || '').includes(p)) + 1, PROJECT);
is('term-ui (desk): the project is on the Projects screen', true, pos >= 1 && pos <= 9);
await key(String(pos), 0, String(pos));
await until(() => evaluate((p) => (document.querySelector('#app .sbar .scope') || {}).textContent?.includes(p), PROJECT), 6000);
// Long enough for the session screen's first poll, which is where the app learns whether
// this device may open a terminal and gets the passkey's challenge ready.
await until(() => evaluate(() => !!document.querySelector('#app .sbar')), 6000);
await sleep(1500);
await key('a', CTRL); await key('t');
const deskOpen = await until(() => evaluate(() => {
  const s = document.querySelector('#app .term-screen .term-host');
  return !!s && !s.hidden && document.querySelectorAll('#app .xterm-rows > div').length > 0;
}), 10000);
is('term-ui (desk): Ctrl-a t opens the terminal, after the passkey', true, !!deskOpen);
is('...in the RIGHT pane, with the grid in the left one', true, await evaluate(() => !!document.querySelector('#app .term-screen') && !!document.querySelector('#side .cards')));
is('...the key row is not drawn at a desk', true, await evaluate(() => { const r = document.querySelector('.term-keys'); return !r || r.hidden; }));
is('...and the terminal has the focus', true, !!(await until(() => focusedInTerm(), 4000)));
await until(() => screenText().then(t => /\$ *$/m.test(t)), 6000);
await shot('desk-open');
await until(() => screenText().then(t => /\$ *$/m.test(t)), 6000);
// The desk's keys go to the SHELL while it has the focus. cat -v shows what arrived.
await typeText('cat -v'); await key('Enter');
await sleep(300);
await key('a', CTRL); await key('f', CTRL); await key('p', CTRL); await key('Backquote');
await key('Enter');
const passed = await until(() => /\^A\^F\^P`/.test(capture()), 5000);
if (!passed) console.error('desk keys: the pane said ' + JSON.stringify(capture().split('\n').filter(Boolean).slice(-12)));
is('term-ui (desk): Ctrl-a, Ctrl-f, Ctrl-p and ` reach the shell, not the desk', true, !!passed);
is('...and the screen did not move', true, await evaluate(() => !!document.querySelector('#app .term-screen') && !document.querySelector('.sheet') && !document.querySelector('.jump')));
await key('d', CTRL);                                    // end cat
// The mouse, where the terminal asks for it: nvim (mouse=nvi in --clean) moves its cursor
// to a click, and `x` then deletes the character UNDER the click.
if (hasNvim) {
  const MF = `mouse-${MARK}.txt`;
  fs.writeFileSync(`${REPO}/${MF}`, 'aaa\nbbb\nccc\n');
  await sleep(300);
  await typeText(`nvim --clean -n ${MF}`); await key('Enter');
  await until(() => screenText().then(t => t.includes('ccc')), 8000);
  // NOT ON THE FIRST FRAME WITH THE TEXT: until xterm has seen nvim ask for the mouse, a
  // click is a selection and nvim never hears it. xterm marks its element once a mode is on.
  // On a macOS runner the click once moved nothing and the `x` deleted the first character
  // of the file; it did not reproduce here, even with the page throttled 20x, so this wait
  // and the line printed after the click are there to say which half it was next time.
  await until(() => evaluate(() => !!document.querySelector('#app .xterm.enable-mouse-events')), 6000);
  await shot('desk-nvim');
  // The row the cursor is drawn on, 0-based: how the click is seen to have reached nvim.
  const cursorRow = () => evaluate(() => [...document.querySelectorAll('#app .xterm-rows > div')].findIndex(d => d.querySelector('.xterm-cursor')));
  const third = await evaluate(() => {
    const r = [...document.querySelectorAll('#app .xterm-rows > div')].find(d => d.textContent.startsWith('ccc'));
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: b.left + 2, y: b.top + b.height / 2 };
  });
  if (third) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: third.x, y: third.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: third.x, y: third.y, button: 'left', clickCount: 1 });
    // ...and the `x` only once nvim has drawn its cursor on that row, not after a fixed wait.
    if (!(await until(async () => (await cursorRow()) === 2, 5000))) {
      const under = await evaluate((x, y) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}.${String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).replace(/ +/g, '.')}` : 'nothing'; }, third.x, third.y);
      console.error(`desk click: the cursor is on row ${await cursorRow()}, mouse mode ${await evaluate(() => !!document.querySelector('#app .xterm.enable-mouse-events'))}, under the click ${under}`);
    }
  } else console.error('desk click: no row of the screen starts with ccc');
  await typeText('x:wq'); await key('Enter');
  const after2 = await until(() => { const t = fs.readFileSync(`${REPO}/${MF}`, 'utf8'); return t !== 'aaa\nbbb\nccc\n' && t; }, 6000);
  is('term-ui (desk): a click moves nvim\'s cursor (x deleted the char under it)', 'aaa\nbbb\ncc\n', after2 || 'unchanged');
}
// ⇧Esc leaves; then ` is the desk's again.
await until(() => screenText().then(t => /\$ *$/m.test(t)), 6000);
await key('Escape', SHIFT);
is('term-ui (desk): ⇧Esc takes the focus out of the terminal', false, await until(async () => !(await focusedInTerm()) && 'out', 3000) ? false : await focusedInTerm());
await key('Backquote');
is('...and then ` is the desk\'s back key again', true, !!(await until(() => evaluate(() => !document.querySelector('.term-screen')), 5000)));

// ── nothing the terminal printed is in serve.log ─────────────────────────────────────
const log = logText();
is('term-ui: serve.log has the opens and closes', true, /terminal open: /.test(log) && /terminal closed: /.test(log));
is('...and not one byte the terminal printed', 0, (log.match(new RegExp(MARK, 'g')) || []).length);
await done(0);
