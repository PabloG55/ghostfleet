// test/helpers/phone-fit.mjs — the phone's screen holds still: no zoom on a tap into a field, a
// composer's buttons of one size, and a page that cannot be dragged any way. Run from
// phone-check.mjs (`--fit-only`), past the lock in fixture mode, with touch emulation ON, which
// the main run leaves off: `(pointer: coarse)` is what a phone matches, and the fields' 16px is
// scoped to it.
//
// Reported from the installed iPhone app, three faults the old client had fixed one report at a
// time and web/ui had not:
//   - "IT ZOOMS IN WHEN YOU CHAT". iOS zooms the page onto a field whose computed size is under
//     16px when it takes the focus. No engine here zooms, so the row measures the cause: every
//     text field's COMPUTED size on every screen that has one, dialogs and the drawer included.
//     Computed, because the fields take their size through `font: inherit` and no file says it.
//   - "SEND AND ATTACHMENT ARE DIFFERENT SIZES". Each composer's buttons, measured as drawn, and
//     the composer measured again after a message is typed into it.
//   - "YOU CAN SCROLL THE WHOLE PAGE LEFT, RIGHT, UP, DOWN". The document's own width; every
//     element, under the overflow net, that runs past the screen outside a box of its own; and
//     touch swipes each way on the page, with something put in the shell that is taller and
//     wider than the screen, as anything drawn outside .main would be. Wide content (a table, a
//     code block in a message) must still scroll sideways inside its own box.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../lib/browser.mjs';

// Every place a field can be: the pages, and the things a tap opens over them.
const PAGES = [['home', '#/'], ['map', '#/map'], ['project', '#/p/acme-api'], ['lead session', '#/p/acme-api/s/master'],
  ['session', '#/p/acme-api/s/api-fix'], ['quiet session', '#/p/acme-api/s/docs-pass'], ['settings', '#/settings'], ['activity', '#/activity'], ['queue', '#/queue'],
  ['held', '#/held'], ['reviews', '#/reviews'], ['one review', '#/reviews/-/work/2026-03-05_14-02-11'],
  ['stack picker', '#/stack-picker'], ['automations', '#/automations'], ['sign-ins', '#/sign-ins'], ['search', '#/search?q=api']];

export async function phoneFit({ b, is, shots = '' }) {
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `fit-${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (fn, ...a) => {
    for (let i = 0; i < 80; i++) { const v = await b.evaluate(fn, ...a).catch(() => null); if (v) return v; await sleep(100); }
    return null;
  };
  const open = async (hash) => {
    await b.evaluate(() => { document.activeElement?.blur?.(); });
    await b.evaluate((x) => { location.hash = x; }, hash);
    await sleep(900);
  };
  const touch = (on) => b.call('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: on ? 5 : 1 });
  const W = 390, H = 844;
  await touch(true);
  await b.viewport(W, H);
  is('touch emulation makes the page a phone\'s: (pointer: coarse)', true, await b.evaluate(() => matchMedia('(pointer: coarse)').matches));

  // Each composer's buttons on the line beside its box: one width and one height, at least 44px,
  // on one centre line. A row of none is a failure: that is a composer this check lost.
  const buttons = (sel) => b.evaluate((s) => {
    const form = document.querySelector(s);
    if (!form) return 'no composer';
    const btns = [...form.querySelectorAll('button')].filter(x => x.getClientRects().length && !x.closest('.att-list, .att-lost, .request-return'));
    if (btns.length < 1) return 'no buttons';
    const r = btns.map(x => x.getBoundingClientRect());
    const sizes = new Set(r.map(x => `${Math.round(x.width)}x${Math.round(x.height)}`));
    const mids = r.map(x => x.top + x.height / 2), spread = Math.max(...mids) - Math.min(...mids);
    const least = Math.min(...r.map(x => Math.min(x.width, x.height)));
    const what = btns.map(x => (x.getAttribute('aria-label') || x.textContent.trim()) + ' ' + Math.round(x.getBoundingClientRect().width) + 'x' + Math.round(x.getBoundingClientRect().height)).join(', ');
    return sizes.size === 1 && least >= 44 && spread <= 0.5 ? `${btns.length} of one size` : what;
  }, sel);

  // ── 1. no zoom on focus: every text field 16px or more ────────────────────
  // The visible text fields of the page and of anything open over it, with any under 16px named.
  const small = () => b.evaluate(() => {
    const TYPED = 'input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=button], [type=submit], [type=reset], [type=image], [type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])';
    // The closed drawer's filter is measured with the drawer open, below, not on every page.
    const all = [...document.querySelectorAll(TYPED)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.side:not(.open)'));
    const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '') + (e.type && e.tagName === 'INPUT' ? `[${e.type}]` : '');
    const under = all.filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => `${name(e)} ${getComputedStyle(e).fontSize}`);
    return { n: all.length, under: [...new Set(under)].join(', ') };
  });
  const fields = async (where) => {
    const m = await small();
    is(`${W} ${where}: every text field is 16px or more`, '', m.under);
    return m.n;
  };
  let seen = 0;
  for (const [name, hash] of PAGES) { await open(hash); seen += await fields(name); }
  // The drawer holds the projects' filter: a field the pages above only have off screen.
  await open('#/');
  await b.evaluate(() => document.querySelector('.topbar .icon-btn')?.click());
  await until(() => !!document.querySelector('.side.open'));
  seen += await fields('the drawer');
  await b.evaluate(() => document.querySelector('.side-scrim')?.click());
  // The assistant's panel, opened from its button, which every page but the first one has.
  await open('#/p/acme-api');
  await b.evaluate(() => document.querySelector('.as-launch')?.click());
  const panel = await until(() => !!document.querySelector('.assistant input'));
  is(`${W} the assistant panel opens, with its box`, true, !!panel);
  seen += await fields('the assistant panel');
  is(`${W} the assistant panel: its send is the composer's size`, '1 of one size', await buttons('.assistant .console form'));
  await b.evaluate(() => document.querySelector('.assistant .as-head .x')?.click());
  await sleep(300);
  // The dialogs with fields: a new session (the project page), a rename (a worker's menu).
  await open('#/p/acme-api');
  await b.evaluate(() => [...document.querySelectorAll('.proj-head .btn')].find(x => /new session/i.test(x.textContent))?.click());
  is(`${W} the new-session dialog opens, with its fields`, true, !!(await until(() => !!document.querySelector('[role=dialog] textarea'))));
  seen += await fields('the new-session dialog');
  await b.evaluate(() => document.querySelector('[role=dialog] .x')?.click());
  await open('#/p/acme-api/s/api-fix');
  await b.evaluate(() => document.querySelector('.sess-tools .menu-wrap .btn')?.click());
  await until(() => !!document.querySelector('.sess-tools .menu'));
  await b.evaluate(() => [...document.querySelectorAll('.sess-tools .menu button')].find(x => /^Rename/.test(x.textContent))?.click());
  is(`${W} the rename dialog opens, with its field`, true, !!(await until(() => !!document.querySelector('[role=dialog] input'))));
  seen += await fields('the rename dialog');
  await b.evaluate(() => document.querySelector('[role=dialog] .x')?.click());
  // A floor that measured nothing proves nothing: the composer, the filter, the searches, the
  // assistant's box and the dialogs' fields come to well over a dozen.
  is('...and the fields it measured are there to measure', true, seen >= 15 || `only ${seen}`);
  // ...and the floor is the touch screen's, not everyone's: with a mouse the composer keeps the
  // app's 14px. Without this the rows above could pass on a page set in 16px for everybody.
  await touch(false);
  await open('#/p/acme-api/s/master');
  is('with a mouse the composer keeps its 14px', '14px', await b.evaluate(() => getComputedStyle(document.querySelector('.composer textarea')).fontSize));
  await touch(true);
  await sleep(200);

  // ── 2. a composer's buttons are one size, and typing moves nothing ─────────
  const rect = (sel) => b.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : 'none'; }, sel);
  // api-fix has a request open, which covers its box with "Answer the request" and holds Send
  // disabled; docs-pass and the lead have none, so a Send that changes as text arrives is seen.
  for (const [name, hash] of [['session with a request', '#/p/acme-api/s/api-fix'], ['session', '#/p/acme-api/s/docs-pass'], ['lead session', '#/p/acme-api/s/master']]) {
    await open(hash);
    is(`${W} ${name}: attach, voice and send are one size, 44px or more, on one line`, '3 of one size', await buttons('.composer .composer-row'));
    if (name === 'session with a request') { await shot('composer-request'); continue; }
    is(`${W} ${name}: the box is there to type in`, true, await b.evaluate(() => getComputedStyle(document.querySelector('.composer textarea')).visibility === 'visible'));
    const before = [await rect('.composer'), await rect('.composer textarea')].join(' | ');
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    await b.call('Input.insertText', { text: 'a message on its way' });
    await sleep(300);
    is(`${W} ${name}: typing a message moves neither the composer nor its box`, before, [await rect('.composer'), await rect('.composer textarea')].join(' | '));
    if (name === 'session') await shot('composer-typed');
    await b.evaluate(() => { const n = document.querySelector('.composer textarea'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); n.blur(); });
  }
  // The assistant: on the first page's card and in its panel, the box and its Send.
  await open('#/');
  is(`${W} the assistant's card: its send is the composer's size`, '1 of one size', await buttons('.home-agent .console form'));
  // The form and its box: a Send that widens once there is text keeps the form's rect and takes
  // the difference out of the box, which is the push this row is for.
  const card = async () => [await rect('.home-agent .console form'), await rect('.home-agent .console input')].join(' | ');
  const cardBefore = await card();
  await b.evaluate(() => document.querySelector('.home-agent .console input').focus());
  await b.call('Input.insertText', { text: 'what needs me' });
  await sleep(300);
  is(`${W} the assistant's card: typing moves neither the card's form nor its box`, cardBefore, await card());
  await b.evaluate(() => { const n = document.querySelector('.home-agent .console input'); n.blur(); });
  // ...and the same size as the session's, not merely equal to itself.
  const sizeOf = (sel) => b.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? `${Math.round(r.width)}x${Math.round(r.height)}` : 'none'; }, sel);
  const cardSend = await sizeOf('.home-agent .console form button[type=submit]');
  await open('#/p/acme-api/s/api-fix');
  is(`${W} ...and that size is the session's`, await sizeOf('.composer button[type=submit]'), cardSend);

  // ── 3. the page itself never moves ────────────────────────────────────────
  // Elements past the screen's edge that nothing holds: not inside a box that scrolls sideways
  // or clips (a table's, the tree's ellipsis), and not the closed drawer. Measured UNDER the
  // overflow net, which hides exactly this from the document's own width.
  const past = () => b.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const held = (e) => { for (let p = e.parentElement; p && p.id !== 'app'; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX, r = p.getBoundingClientRect();
      if (o !== 'visible' && !p.matches('.main') && r.left >= -0.5 && r.right <= vw + 0.5) return true; } return false; };
    const out = [];
    for (const e of document.querySelectorAll('#app *')) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || (r.right <= vw + 0.5 && r.left >= -0.5)) continue;
      if (getComputedStyle(e).visibility === 'hidden' || e.closest('.side:not(.open)') || held(e)) continue;
      out.push(`${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''} to ${Math.round(r.right)}`);
    }
    const main = document.querySelector('.main');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push(`.main scrolls ${main.scrollWidth - main.clientWidth} px`);
    return [...new Set(out)].slice(0, 5).join(', ');
  });
  for (const w of [320, 375, 390, 430]) {
    await b.viewport(w, H);
    for (const [name, hash] of PAGES) {
      await open(hash);
      const d = await b.evaluate(() => { const s = document.scrollingElement; return s.scrollWidth - s.clientWidth; });
      if (w === 320 || w === 390) is(`${w} ${name}: the document is the screen's width`, 0, d);
      is(`${w} ${name}: nothing runs past the screen's edge`, '', await past());
    }
  }
  await b.viewport(W, H);

  // Swipes on the page: a finger on the top bar and one on the page's content, each way. The
  // shell holds even with something in it taller and wider than the screen, put where the frame
  // puts what it draws outside .main (the app's `after`, the desk's keys): that is what made the
  // document scrollable before, and a page with nothing in it would pass either way.
  const swipe = async (x, y, dx, dy) => {
    await b.call('Input.synthesizeScrollGesture', { x, y, xDistance: dx, yDistance: dy, gestureSourceType: 'touch', speed: 1200, preventFling: true });
    await sleep(250);
  };
  // Where the page is, read by the browser rather than the page: phone-check stands its own
  // visualViewport in for the platform's, and under mobile emulation a page wider than the screen
  // is panned by moving the VISUAL viewport while window.scrollX stays 0, as a zoomed iPhone's is.
  const where = async () => {
    const m = await b.call('Page.getLayoutMetrics');
    const L = m.cssLayoutViewport || m.layoutViewport, V = m.cssVisualViewport || m.visualViewport;
    const bar = await b.evaluate(() => { const a = document.getElementById('app').getBoundingClientRect(), t = document.querySelector('.topbar')?.getBoundingClientRect(); return `shell ${Math.round(a.left)},${Math.round(a.top)} · bar ${t ? Math.round(t.top) : '-'}`; });
    return `page ${Math.round(L.pageX)},${Math.round(L.pageY)} · seen ${Math.round(V.pageX)},${Math.round(V.pageY)} x${Number(V.scale || V.zoom || 1).toFixed(2)} · ${bar}`;
  };
  const STILL = 'page 0,0 · seen 0,0 x1.00 · shell 0,0 · bar 0';
  for (const [name, hash] of [['home', '#/'], ['session', '#/p/acme-api/s/api-fix'], ['project', '#/p/acme-api']]) {
    await open(hash);
    await b.evaluate(() => { const d = document.createElement('div'); d.id = 'fit-big'; d.style.cssText = 'width:1400px;height:2600px;flex:none'; document.querySelector('.app').appendChild(d); });
    const moved = [];
    for (const [label, x, y] of [['the top bar', 200, 24], ['the page', 200, 420]]) {
      for (const [dir, dx, dy] of [['up', 0, -300], ['down', 0, 300], ['left', -250, 0], ['right', 250, 0]]) {
        await swipe(x, y, dx, dy);
        const at = await where();
        if (at !== STILL) moved.push(`${dir} on ${label}: ${at}`);
        await b.evaluate(() => { scrollTo(0, 0); document.getElementById('app').scrollTo?.(0, 0); });
        await b.call('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
      }
    }
    await b.evaluate(() => document.getElementById('fit-big')?.remove());
    is(`${W} ${name}: a swipe each way moves nothing, with something too big for the screen in it`, '', moved.join('; '));
  }
  // ...and the measurement is not blind: the same swipe on a page that CAN move says it moved.
  await open('#/');
  const blind = await b.evaluate(() => {
    const s = document.createElement('style'); s.id = 'fit-undo';
    s.textContent = '#app { position: static !important; overflow: visible !important; height: auto !important; } html, body { overflow: visible !important; height: auto !important; } .app { height: auto !important; grid-template-columns: 1fr !important; }';
    document.head.append(s);
    const d = document.createElement('div'); d.id = 'fit-big'; d.style.cssText = 'width:1400px;height:2600px'; document.querySelector('.app').appendChild(d);
    return true;
  });
  await swipe(200, 24, 0, -300);
  const sawIt = (await where()) !== STILL;
  await b.evaluate(() => { document.getElementById('fit-undo')?.remove(); document.getElementById('fit-big')?.remove(); scrollTo(0, 0); });
  is('...and a swipe on a page that can move is seen moving it', true, blind && sawIt);

  // ── 4. wide content still scrolls inside its own box ──────────────────────
  // The session's table is the fixture's; a code block is drawn into a message of the chat by the
  // app's own markdown, as an agent's diff would be. A swipe left on each moves the box, not the page.
  await open('#/p/acme-api/s/api-fix');
  await b.evaluate(async () => {
    const { render } = await import(location.origin + '/md.js');
    const last = [...document.querySelectorAll('.chat .msg.ai')].pop();
    const msg = last.cloneNode(true); msg.id = 'fit-code';
    const md = msg.querySelector('.md') || msg.querySelector('.bubble');
    md.replaceChildren(render('```\n' + 'const backoff = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000]; // ' + 'retry '.repeat(30) + '\n```', document));
    last.after(msg);
  });
  for (const [name, sel] of [['table', '.chat .md .md-table'], ['code block', '#fit-code .md-code, #fit-code pre']]) {
    const r = await b.evaluate((s) => {
      const box = document.querySelector(s);
      if (!box) return null;
      box.scrollIntoView({ block: 'center' });
      const q = box.getBoundingClientRect();
      return { wide: box.scrollWidth > box.clientWidth + 20, x: Math.round(q.left + q.width / 2), y: Math.round(q.top + Math.min(q.height / 2, 20)) };
    }, sel);
    if (!r) { is(`${W} a ${name} in a message scrolls sideways in its own box`, 'scrolled', `no ${name} found`); continue; }
    await sleep(200);
    await swipe(r.x, r.y, -180, 0);
    const got = await b.evaluate((s) => ({ box: Math.round(document.querySelector(s).scrollLeft), page: Math.round(scrollX), main: Math.round(document.querySelector('.main').scrollLeft) }), sel);
    is(`${W} a ${name} in a message scrolls sideways in its own box`, 'scrolled',
       r.wide && got.box > 20 && got.page === 0 && got.main === 0 ? 'scrolled' : `wider than its box: ${r.wide}; box ${got.box}, page ${got.page}, main ${got.main}`);
    if (name === 'code block') await shot('code-scrolled');
  }
  await b.evaluate(() => document.getElementById('fit-code')?.remove());
  await touch(false);
}
