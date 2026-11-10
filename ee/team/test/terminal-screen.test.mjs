// A project's Terminal and Editor tabs, in a real (headless) browser against the demo server:
// who is offered them, that a key typed comes back and a resize is sent, that every key stays
// in the terminal while it has the focus and the two ways out work, what each way of closing
// says, and that back returns to the page before. The server half is terminal.test.mjs; this
// is the screen (web/ui/terminal.jsx over web/term.js).
//
// Skipped, saying why, where there is no Chrome or no build (`pnpm build` first): the page it
// drives is the built one, served by the server as it is in production.
//
// GFW_TERM_SHOTS=<folder> also writes a screenshot of each state, at 1440×900, in
// English and Spanish, for a person to look at. Nothing asserts on pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rig } from './helpers/demo-rig.mjs';
import { launch, findChrome, sleep } from '../../../lib/browser.mjs';

const DIST = new URL('../web/dist/index.html', import.meta.url).pathname;
const skip = !findChrome() ? 'no Chrome on this machine' : !fs.existsSync(DIST) ? 'no build: run `pnpm build` first' : false;
const SHOTS = process.env.GFW_TERM_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// A desk is launched as a desk: headless Chrome otherwise reports no fine pointer at all.
const MOUSE = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
const SESSION = '#/p/acme-web/s/onboarding', PROJECT = '#/p/acme-web';
const EDITOR_MISSING = 'no editor on this machine — the installer adds Neovim, or set CLAUDE_FLEET_EDITOR';

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
const shot = async (p, name) => {
  if (!SHOTS) return;
  await sleep(250);                        // a frame for the last state to be drawn
  const { data } = await p.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
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
const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  q: { key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, text: 'q' },
  Q: { key: 'Q', code: 'KeyQ', windowsVirtualKeyCode: 81, text: 'Q', modifiers: 8 },
  '`': { key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, text: '`' },
  'Ctrl-f': { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 },
  'Shift-Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 8 },
};
async function press(p, name) {
  const k = KEYS[name];
  await p.call('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k });
  await p.call('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
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
const note = (p, kind) => until(p, (kind) => {
  const n = document.querySelector(`.tool-note.n-${kind}`);
  return n && n.textContent;
}, `the ${kind} notice`, 15000, kind).catch(explain(p));
const inTerminal = (p) => p.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
const hash = (p) => p.evaluate(() => location.hash);
const toHash = async (p, h) => { await p.evaluate((h) => { location.hash = h; }, h); await sleep(50); };

// A second tab comes up in front and leaves the first HIDDEN: no frames, so a touch waits for
// one forever and Preact runs effects only on its fallback timer. Closed, the first is shown
// again — so a second tab lives only as long as the step that needs it.
const shut = (b, q) => b.call('Target.closeTarget', { targetId: q.targetId }).catch(() => {});
// One browser tab, signed in as `cookie`, with the probe in it.
async function page(b, r, tabOf = null) {
  const p = tabOf || b;
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
// Holds every request matching `pattern` and answers it with `answer(n, paused)`: a
// { status, body } to answer in the server's place, or nothing to let the real one through.
// At stage 'Response' the server has already answered and the answer is only held. Returns
// a stop function.
async function intercept(b, p, pattern, answer, stage = 'Request') {
  let n = 0;
  await p.call('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: stage }] });
  const off = b.onEvent(async (method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const a = await answer(n++, params);
    if (!a && params.responseStatusCode != null) {
      return p.call('Fetch.continueResponse', { requestId: params.requestId })
        .catch(() => p.call('Fetch.continueRequest', { requestId: params.requestId })).catch(() => {});
    }
    if (!a) return p.call('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    p.call('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: a.status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(a.body)).toString('base64') }).catch(() => {});
  });
  return async () => { off(); await p.call('Fetch.disable').catch(() => {}); };
}
// The same, for the length of `fn` only: a failed assertion inside must not leave the next
// test's requests held by this one's answers.
async function held(b, p, pattern, answer, stage, fn) {
  const stop = await intercept(b, p, pattern, answer, stage);
  try { return await fn(); } finally { await stop(); }
}

test('a desk: who sees the tabs, typing, keys, back, and every way a tab closes', { skip, timeout: 240000 }, async (t) => {
  const r = await rig(t);
  const b = await launch({ width: 1440, height: 900, scale: 1, args: [MOUSE] });
  t.after(() => b.close());
  const cookie = { admin: await r.login('admin'), member: await r.login('member'), viewer: await r.login('viewer') };
  const p = await page(b, r);
  let clock = 0;
  const advance = (ms) => { clock += ms; r.advance(clock); };

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

  await t.test('every key goes to the editor while it has the focus; ⇧Esc, the button and ⏎ move it', async () => {
    await click(p, '.tool-tab[href$="/edit"]');
    await opened(p, 'edit');
    await until(p, () => document.activeElement?.classList.contains('xterm-helper-textarea'), 'the editor to take the keyboard');
    await until(p, () => (document.querySelector('.tool-host .xterm-rows')?.textContent || '').includes('scratch.js'), 'the demo file');
    const at = await hash(p);
    for (const [k, byte] of [['Escape', '\x1b'], ['q', 'q'], ['`', '`'], ['Q', 'Q'], ['Ctrl-f', '\x06']]) {
      const n = (await sent(p)).length;
      await press(p, k);
      await until(p, (n) => window.__ws.at(-1).sent.length > n, `${k} to be sent`, 5000, n);
      assert.equal((await sent(p)).slice(n).join(''), byte, `${k} sent the wrong bytes`);
      assert.equal(await hash(p), at, `${k} moved the page`);
      assert.equal(await p.evaluate(() => !!document.querySelector('.keyprompt')), false, `${k} started an app chord`);
      assert.ok(await inTerminal(p), `${k} took the focus out of the editor`);
    }
    const n = (await sent(p)).length;
    await press(p, 'Shift-Escape');
    await until(p, () => document.activeElement === document.querySelector('.tool'), '⇧Esc to leave');
    assert.equal((await sent(p)).length, n, '⇧Esc was sent to the editor');
    assert.equal(await hash(p), at);
    assert.match(await p.evaluate(() => document.querySelector('.tool-leave').textContent), /Type in editor/);
    await press(p, 'Enter');
    await until(p, () => document.activeElement?.classList.contains('xterm-helper-textarea'), '⏎ to go back in');
    assert.equal(await hash(p), at, '⏎ on the panel moved the page');
    assert.match(await p.evaluate(() => document.querySelector('.tool-leave').textContent), /Leave editor/);
    await click(p, '.tool-leave');
    await until(p, () => document.activeElement === document.querySelector('.tool'), 'the button to leave');
    await click(p, '.tool-leave');
    await until(p, () => document.activeElement?.classList.contains('xterm-helper-textarea'), 'the button to go back in');
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

  await t.test('opened in a second tab: the first says so, and Reconnect takes it back', async () => {
    await p.open(`${SESSION}/term`);
    await opened(p);
    const q = await page(b, r, await b.newTab());
    await q.open(`${SESSION}/term`);
    await opened(q);
    assert.match(await note(p, 'takeover'), /Opened in another tab/);
    await click(p, '.tool-note button');
    await opened(p);
    assert.match(await note(q, 'takeover'), /Opened in another tab/);
    await shut(b, q);
  });

  await t.test('closed after 30 minutes idle, and Reconnect opens it again', async () => {
    await opened(p);
    advance(31 * 60e3);
    assert.match(await note(p, 'idle'), /Closed after 30 min idle/);
    await click(p, '.tool-note button');
    await opened(p);
  });

  await t.test('a ticket that expired is reopened once, silently; twice says so, and stops', async () => {
    // Paused at the response, the clock moved past the ticket's 30 s, then let through: the
    // socket is refused before hello, exactly as an expired ticket is in the field.
    let expire = 0;
    await p.open(SESSION);
    await held(b, p, '*/api/term/open*', async () => { if (expire-- > 0) advance(31e3); return null; }, 'Response', async () => {
      expire = 1;
      await click(p, '.tool-tab[href$="/edit"]');
      await opened(p, 'edit');
      assert.equal(await p.evaluate(() => window.__posts), 2, 'not exactly one silent reopen');
      assert.equal(await p.evaluate(() => window.__ws.length), 2, 'not exactly two sockets');
      expire = 2;
      await click(p, '.tool-tab[href$="/term"]');
      const failed = await note(p, 'failed');
      assert.match(failed, /Could not connect/);
      // In the reader's words: not term.js's own English fallback, which no catalog translates.
      assert.match(failed, /The server did not take the connection/);
      assert.doesNotMatch(failed, /the connection dropped/);
      await sleep(1500);                     // long enough for a loop to show itself
      assert.equal(await p.evaluate(() => window.__posts), 4, 'a failed reopen was retried again');
    });
    await click(p, '.tool-note button');
    await opened(p, 'term');
  });

  await t.test('no editor on the machine: the server\'s own sentence', async () => {
    await p.open(SESSION);
    await held(b, p, '*/api/term/open*', async () => ({ status: 502, body: { ok: false, text: EDITOR_MISSING } }), 'Request', async () => {
      await click(p, '.tool-tab[href$="/edit"]');
      const text = await note(p, 'noEditor');
      assert.match(text, /No editor on this machine/);
      assert.ok(text.includes(EDITOR_MISSING), text);
    });
  });

  await t.test('a temporary password: a link to change it, which opens the change', async () => {
    await p.open(SESSION);
    await held(b, p, '*/api/*', async (n, req) => {
      if (req.request.url.includes('/api/term/open')) return { status: 403, body: { ok: false, text: 'Change your password first.' } };
      if (!req.request.url.includes('/api/health')) return null;
      const h = await r.call('GET', '/api/health', undefined, cookie.member);
      return { status: 200, body: { ...h.body, user: { ...h.body.user, mustChange: true } } };
    }, 'Request', async () => {
      await click(p, '.tool-tab[href$="/term"]');
      assert.match(await note(p, 'password'), /Change your password first/);
      await click(p, '.tool-note button');
      await until(p, () => !!document.querySelector('.auth input[type="password"]') && !document.querySelector('.app'), 'the password change');
    });
  });

  await t.test('signed out under the page: says so, and Sign in goes to the sign-in', async () => {
    await p.open(`${SESSION}/edit`);
    await opened(p);
    await p.call('Network.clearBrowserCookies');
    await click(p, '.tool-tab[href$="/term"]');
    assert.match(await note(p, 'signedOut'), /You are signed out/);
    await click(p, '.tool-note button');
    await until(p, () => !!document.querySelector('.auth') && !document.querySelector('.app'), 'the sign-in');
  });

  await t.test('a grant taken away: the open tab goes, and so do the tabs, without trapping back', async () => {
    await signIn(p, cookie.member);
    await p.open(SESSION);
    await click(p, '.tool-tab[href$="/term"]');
    await opened(p);
    const depth = await p.evaluate(() => history.length);
    const users = (await r.call('GET', '/api/admin/users', undefined, cookie.admin)).body.users;
    const id = users.find(u => u.name === 'member').id;
    const res = await r.call('POST', '/api/admin/users/update', { id, projects: { 'acme-web': 'viewer' } }, cookie.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await until(p, (h) => location.hash === h && !document.querySelector('.tool'), 'the session page', 15000, SESSION);
    assert.equal(await p.evaluate(() => document.querySelectorAll('.tool-tab').length), 0, 'the tabs stayed');
    assert.equal(await p.evaluate(() => history.length), depth, 'the way out added a history entry');
  });

  if (SHOTS) await t.test('screenshots', () => shootAll(b, p, r, 'desk', cookie.admin, (ms) => r.advance(clock + ms)));
});

// Every state a person can see, for a person to look at: the terminal and the editor open, on
// the session page and on the project page, and each notice. In English and in Spanish. The
// notices whose cause cannot be made on demand in the demo (no editor, a temporary password,
// a sign-in that ended, a ticket that cannot be used) are answered in the server's place, AFTER
// a normal load and from the tab a person presses, as they happen in the field. (A hash set by
// script the moment a page has loaded can land before the route hook listens, and is lost.)
async function shootAll(b, p, r, dev, cookie, advance) {
  let clock = 0;
  const later = (ms) => { clock += ms; advance(clock); };
  const hit = click;
  const only = (path, answer) => async (n, q) => (q.request.url.includes(path) ? answer() : null);
  await p.evaluate(() => { try { localStorage.removeItem('gfw.termFont'); } catch {} });   // the size a person starts at
  for (const lang of ['en', 'es']) {
    await r.call('POST', '/api/lang', { lang }, cookie);
    await signIn(p, cookie);
    const name = (s) => `${dev}-${lang}-${s}`;
    // The two pages as they are without a tab open: the project page's new bar, and the
    // session's read-only tab under its new name.
    await p.open(SESSION); await until(p, () => document.querySelectorAll('.tool-tab').length === 2, 'the session tabs');
    await shot(p, name('session-conversation'));
    await p.open(PROJECT); await until(p, () => !!document.querySelector('.page-tabs'), 'the project tabs');
    await shot(p, name('project-sessions'));
    for (const [base, where] of [[SESSION, 'session'], [PROJECT, 'project']]) {
      for (const kind of ['term', 'edit']) {
        await p.open(`${base}/${kind}`); await opened(p, kind); await shot(p, name(`${where}-${kind}-open`));
      }
    }
    const fake = async (base, tool, kind, answer) => {
      await p.open(base);
      await held(b, p, '*/api/*', answer, 'Request', async () => {
        await hit(p, `.tool-tab[href$="/${tool}"]`);      // pressed, as a person reaches it
        await note(p, kind); await shot(p, name(`note-${kind.toLowerCase()}`));
      });
    };
    await fake(SESSION, 'term', 'failed', only('/api/term/open', () => ({ status: 200, body: { ok: true, ticket: 'not-a-ticket', session: '_term-acme-web', ttl: 30, idle: 1800 } })));
    await fake(PROJECT, 'edit', 'noEditor', only('/api/term/open', () => ({ status: 502, body: { ok: false, text: EDITOR_MISSING } })));
    await fake(SESSION, 'term', 'signedOut', only('/api/term/open', () => ({ status: 401, body: { ok: false, text: 'Sign in first.' } })));
    await fake(SESSION, 'term', 'password', async (n, q) => {
      if (q.request.url.includes('/api/term/open')) return { status: 403, body: { ok: false, text: 'Change your password first.' } };
      if (!q.request.url.includes('/api/health')) return null;
      const h = await r.call('GET', '/api/health', undefined, cookie);
      return { status: 200, body: { ...h.body, user: { ...h.body.user, mustChange: true } } };
    });
    await p.open(`${SESSION}/term`); await opened(p, 'term');
    const q = await page(b, r, await b.newTab());
    await q.open(`${SESSION}/term`); await opened(q, 'term');
    await note(p, 'takeover');
    await shut(b, q);
    await shot(p, name('note-takeover'));
    await p.open(`${SESSION}/term`); await opened(p, 'term');
    later(31 * 60e3);
    await note(p, 'idle'); await shot(p, name('note-idle'));
  }
}
