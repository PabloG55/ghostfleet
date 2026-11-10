// A project's Terminal and Editor tabs, in a real (headless) browser against the demo server:
// who is offered them, that a key typed comes back and a resize is sent, and that back returns
// to the page before. The server half is terminal.test.mjs; this is the screen
// (web/ui/terminal.jsx over web/term.js).
//
// Skipped, saying why, where there is no Chrome or no build (`pnpm build` first): the page it
// drives is the built one, served by the server as it is in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rig } from './helpers/demo-rig.mjs';
import { launch, findChrome, sleep } from '../../../lib/browser.mjs';

const DIST = new URL('../web/dist/index.html', import.meta.url).pathname;
const skip = !findChrome() ? 'no Chrome on this machine' : !fs.existsSync(DIST) ? 'no build: run `pnpm build` first' : false;
// A desk is launched as a desk: headless Chrome otherwise reports no fine pointer at all.
const MOUSE = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
const SESSION = '#/p/acme-web/s/onboarding', PROJECT = '#/p/acme-web';

// Every socket the page opens and every ticket it asks for, recorded before the app's own code
// runs: what was sent (binary frames as their text), what came back, and how each one closed.
const PROBE = `(() => {
  const W = window.WebSocket, dec = new TextDecoder();
  window.__ws = []; window.__posts = 0;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      const rec = { sent: [], got: [], code: null };
      window.__ws.push(rec);
      const send = this.send.bind(this);
      this.send = (d) => { rec.sent.push(typeof d === 'string' ? d : dec.decode(d)); return send(d); };
      this.addEventListener('message', (m) => rec.got.push(typeof m.data === 'string' ? m.data : dec.decode(m.data)));
      this.addEventListener('close', (e) => { rec.code = e.code; });
    }
  };
  const F = window.fetch;
  window.fetch = (u, o) => { if (String(u).includes('/api/term/open')) window.__posts++; return F(u, o); };
})();`;

async function until(p, fn, what, ms = 10000, ...args) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await p.evaluate(fn, ...args); if (last) return last; } catch (e) { last = e.message; }
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
// The middle of the first visible `sel` (whose text is `text`, when given), once it has held
// still: a page still laying itself out moves a tab between the measure and the press, and the
// press lands on whatever is there instead. Measured twice from here, not across animation
// frames, which a tab behind another one never draws.
async function center(p, sel, text = null) {
  const what = `${sel}${text == null ? '' : ` "${text}"`}`;
  const at = () => until(p, (sel, text) => {
    const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length && (text == null || x.textContent === text));
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, what, 10000, sel, text);
  for (let a = await at(), i = 0; ; i++) {
    await sleep(80);
    const b = await at();
    if ((b.x === a.x && b.y === a.y) || i === 20) return b;
    a = b;
  }
}
// A real press, not element.click(): the buttons beside the terminal keep the focus by
// refusing the press itself, and only a pointer that goes down shows whether they do.
async function click(p, sel) {
  const { x, y } = await center(p, sel);
  await p.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await p.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await p.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const sent = (p) => p.evaluate(() => (window.__ws.at(-1) || { sent: [] }).sent);
// What the panel shows, for a wait that timed out to say what it found instead.
const state = (p) => p.evaluate(() => ({
  hash: location.hash, auth: !!document.querySelector('.auth'), text: document.querySelector('.main')?.innerText.slice(0, 160), panel: document.querySelector('.tool')?.className, host: document.querySelector('.tool-host')?.className,
  note: document.querySelector('.tool-note')?.textContent, cap: document.querySelector('.tool-cap')?.textContent,
  sockets: window.__ws.map(w => ({ got: w.got.filter(m => m.startsWith('{')).slice(0, 3), code: w.code })), posts: window.__posts,
})).catch(e => e.message);
const explain = (p) => async (e) => { e.message += `\n  page: ${JSON.stringify(await state(p))}`; throw e; };
// Open, and the one asked for: right after a click the tab being left still looks open.
const opened = (p, kind = null) => until(p, (kind) => {
  const ws = window.__ws.at(-1);
  return !!document.querySelector(`.tool${kind ? `.k-${kind}` : ''} .tool-host:not(.off)`) && !!ws && ws.got.some(m => m.includes('"ready"'))
    && !document.querySelector('.tool-note');
}, `the ${kind || ''} tab to be open`, 10000, kind).catch(explain(p));
const hash = (p) => p.evaluate(() => location.hash);
const toHash = async (p, h) => { await p.evaluate((h) => { location.hash = h; }, h); await sleep(50); };

// One browser tab, signed in as `cookie`, with the probe in it.
async function page(b, r) {
  const p = b;
  await p.call('Network.enable');
  await p.call('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  p.origin = `http://127.0.0.1:${r.port}`;
  // A LOAD, every time. A navigation that differs from the page it leaves only after the `#`
  // is a hash change in the same document, and the app would keep whoever it signed in as.
  let loads = 0;
  p.open = async (h) => {
    await p.call('Page.navigate', { url: `${p.origin}/?load=${++loads}${h}` });
    await until(p, () => document.readyState === 'complete' && !!document.querySelector('.app, .auth'), 'the app');
  };
  return p;
}
async function signIn(p, cookie) {
  const at = cookie.indexOf('=');                 // a value can carry '=' of its own
  await p.call('Network.clearBrowserCookies');     // whoever was signed in before is gone
  await p.call('Network.setCookie', { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: p.origin, httpOnly: true });
}
test('a desk: who sees the tabs, typing, and back', { skip, timeout: 240000 }, async (t) => {
  const r = await rig(t);
  const b = await launch({ width: 1440, height: 900, scale: 1, args: [MOUSE] });
  t.after(() => b.close());
  const cookie = { admin: await r.login('admin'), member: await r.login('member'), viewer: await r.login('viewer') };
  const p = await page(b, r);

  await t.test('a viewer is offered neither tab, and a typed address goes back to its page', async () => {
    await signIn(p, cookie.viewer);
    await p.open(SESSION);
    // Signed in for real: an absent tab proves nothing on a page that never loaded.
    await until(p, () => document.querySelectorAll('.session .tabs [role="tab"]').length >= 2 && !!document.querySelector('.side-foot'), 'the session tabs');
    assert.equal(await p.evaluate(() => document.querySelector('.side-foot .ellipsis')?.textContent), 'viewer');
    assert.equal(await p.evaluate(() => document.querySelectorAll('.tool-tab').length), 0, 'a viewer was offered a tool tab');
    await toHash(p, PROJECT);
    await until(p, () => !!document.querySelector('.page-head h1'), 'the project page');
    assert.equal(await p.evaluate(() => !!document.querySelector('.page-tabs')), false, 'a viewer got the project tab bar');
    await toHash(p, `${PROJECT}/term`);
    await until(p, (h) => location.hash === h, 'the project page again', 10000, PROJECT);
    assert.equal(await p.evaluate(() => !!document.querySelector('.tool')), false);
    assert.equal(await p.evaluate(() => window.__posts), 0, 'a viewer asked for a ticket');
  });

  await t.test('a member and an admin see both, beside the agent\'s screen, on both pages', async () => {
    for (const who of ['member', 'admin']) {
      await signIn(p, cookie[who]);
      await p.open(SESSION);
      const tabs = await until(p, () => {
        const xs = [...document.querySelectorAll('.session .tabs [role="tab"]')].map(e => e.textContent.trim());
        return xs.length === 4 && xs;
      }, `${who}'s four tabs`);
      assert.deepEqual(tabs, ['Conversation', 'Agent\'s screen', 'Terminal', 'Editor'], who);
      await toHash(p, PROJECT);
      const bar = await until(p, () => {
        const xs = [...document.querySelectorAll('.page-tabs [role="tab"]')].map(e => e.textContent.trim());
        return xs.length === 3 && xs;
      }, `${who}'s project tabs`);
      assert.deepEqual(bar, ['Sessions', 'Terminal', 'Editor'], who);
    }
  });

  await t.test('typing reaches the terminal and comes back, and a resize is sent', async () => {
    await signIn(p, cookie.member);
    await p.open(SESSION);
    await click(p, '.tool-tab[href$="/term"]');
    await opened(p, 'term');
    assert.equal(await hash(p), `${SESSION}/term`);
    const cap = await p.evaluate(() => document.querySelector('.tool-cap').textContent);
    assert.match(cap, /acme-web's own terminal, the same tab from every session/);
    assert.match(cap, /_term-acme-web/);
    await until(p, () => document.activeElement?.classList.contains('xterm-helper-textarea'), 'the terminal to take the keyboard');
    await p.call('Input.insertText', { text: 'probe-42-echo' });
    await until(p, () => (document.querySelector('.tool-host .xterm-rows')?.textContent || '').includes('probe-42-echo'), 'the echo on screen');
    assert.ok((await sent(p)).some(s => s.includes('probe-42-echo')), 'the bytes were never sent');
    const cols = async () => (await sent(p)).filter(s => s.startsWith('{"t":"resize"')).map(s => JSON.parse(s).cols);
    const before = (await cols()).at(-1);
    assert.ok(before > 40, `opened at ${before} columns`);
    await b.viewport(1100, 800);
    await until(p, (n) => (window.__ws.at(-1).sent.filter(s => s.startsWith('{"t":"resize"')).map(s => JSON.parse(s).cols).at(-1)) < n,
      'a narrower resize frame', 10000, before);
    await b.viewport(1440, 900);
    await until(p, (n) => (window.__ws.at(-1).sent.filter(s => s.startsWith('{"t":"resize"')).map(s => JSON.parse(s).cols).at(-1)) === n,
      'the width back', 10000, before);
  });

  await t.test('a tab is a page: back returns to the one before', async () => {
    await p.open(SESSION);
    await click(p, '.tool-tab[href$="/term"]');
    await until(p, (h) => location.hash === h, 'the terminal route', 5000, `${SESSION}/term`);
    await p.evaluate(() => history.back());
    await until(p, (h) => location.hash === h && !document.querySelector('.tool'), 'back on the session', 5000, SESSION);
    assert.equal(await p.evaluate(() => document.querySelector('.session .tabs .on')?.textContent), 'Conversation');
    await toHash(p, PROJECT);
    await click(p, '.page-tabs a[href$="/edit"]');
    await until(p, (h) => location.hash === h, 'the editor route', 5000, `${PROJECT}/edit`);
    await p.evaluate(() => history.back());
    await until(p, (h) => location.hash === h && !document.querySelector('.tool'), 'back on the project', 5000, PROJECT);
  });
});
