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
//   - And, seen in this file's own shot of a typed message, the floating Assistant button over the
//     composer's corner: it floats 8 px above a composer with the keyboard down, at a desk too.
//
// Then four seen on the iOS simulator, in the installed app, once those were fixed:
//   - THE BUTTON OVER A STRIP OF CHAT. With the keyboard up the chat left visible is about 140pt and
//     the button covered a third of it. It is not drawn while the keyboard is up, and the newest
//     message sits where it would on a page with no button, a reader at the end staying there.
//   - THE HINT CUT IN HALF. The placeholder wrapped to three lines in the two-line box and the third
//     showed half cut off. On a touch screen it is drawn on one line.
//   - TEXT RUNNING INTO THE BORDER. Three lines in the box, and the first sat flush against its top
//     border with its tops cut: a textarea's padding scrolls with its text. Nothing is drawn in the
//     box's inset at any scroll.
//   - (A connected keyboard sliding the top bar off the screen is phone-check.mjs's, beside the other
//     keyboard rows; the one row here asks that ⏎ still sends with it.)
// And one more from the installed app once those were: "the chat button is taller than the mic
// attach and send". The box rested at its two rows, 68 px beside three 46 px buttons. It is asked
// at rest against its buttons at 320, 390 and 430 in both languages, and asked to grow only as
// lines are typed (2c).
// The second and third are asked of the PIXELS (ink() below), because the question is where text is
// drawn, which no style and no rect says.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../lib/browser.mjs';
import { decodePng } from '../../mods/ghostfleet/hooks/peek-shape.js';

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
  // Ink: how many pixels of a horizontal band of an element (y0..y1 from its top, 3 px in from the
  // left, clear of its frame, and 20 px in from the right, clear of the grip a desktop engine draws
  // in a textarea's corner) differ from the element's own background by more than anti-aliasing
  // does. Read off a screenshot of the band, so it is what was painted: a hint wrapped onto a second
  // line, or text scrolled into a box's padding, is ink where no rect or computed style shows it.
  const ink = async (sel, y0, y1) => {
    const e = await b.evaluate((s) => {
      const n = document.querySelector(s), r = n?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, w: r.width, bg: (getComputedStyle(n).backgroundColor.match(/[\d.]+/g) || []).map(Number) } : null;
    }, sel);
    if (!e || y1 - y0 < 1) return -1;
    const { data } = await b.call('Page.captureScreenshot', { format: 'png', clip: { x: e.x + 3, y: e.y + y0, width: e.w - 23, height: y1 - y0, scale: 1 } });
    const pic = decodePng(new Uint8Array(Buffer.from(data, 'base64')));
    if (!pic) return -1;
    let n = 0;
    for (let i = 0; i < pic.rgba.length; i += 4) {
      if (Math.max(Math.abs(pic.rgba[i] - e.bg[0]), Math.abs(pic.rgba[i + 1] - e.bg[1]), Math.abs(pic.rgba[i + 2] - e.bg[2])) > 48) n++;
    }
    return n;
  };
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
  // ...and its whole hint, file and ⏎ included, wherever ⏎ sends: a mouse, the same question
  // keys.js asks. The short one is the touch screen's (section 2b). Asked as agreement, not as
  // "full": a headless browser on Linux has no pointer at all, matches neither (hover: hover) nor
  // (pointer: fine), and there ⏎ is a new line, so the full hint would promise what ⏎ will not do.
  // Where a mouse is (the macOS leg, a desk), this is the full hint.
  is('...and its whole hint, dragging a file and ⏎ included, where a mouse makes ⏎ send', 'agrees',
     await b.evaluate(() => {
       const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
       const full = /Enter sends/.test(document.querySelector('.composer textarea').placeholder);
       return fine === full ? 'agrees' : fine ? 'a mouse, and the short hint' : 'no mouse, and a hint that says ⏎ sends';
     }));
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

  // ── 2b. the box's hint is one line, and its text never runs into its inset ──
  // Seen on the simulator: the hint wrapped to three lines in the two-line box, the third cut in
  // half; and with three lines typed the first sat against the top border, its tops cut. Asked of
  // the pixels: no hint below its first line, and no text in the box's top or bottom inset (the
  // distance from its edge to where the first line starts with nothing scrolled) at any scroll.
  const boxAt = () => b.evaluate(() => {
    const t = document.querySelector('.composer textarea'), cs = getComputedStyle(t), r = t.getBoundingClientRect();
    return { hint: t.placeholder, typed: t.value, first: t.clientTop + parseFloat(cs.paddingTop), lh: parseFloat(cs.lineHeight), h: r.height, max: t.scrollHeight - t.clientHeight };
  });
  for (const w of [320, 390]) {
    await b.viewport(w, H);
    for (const [name, hash] of [['lead session', '#/p/acme-api/s/master'], ['quiet session', '#/p/acme-api/s/docs-pass']]) {
      await open(hash);
      await until(() => !!document.querySelector('.composer textarea')?.placeholder);
      const g = await boxAt();
      const on = await ink('.composer textarea', g.first + 2, g.first + g.lh - 2);
      const below = await ink('.composer textarea', g.first + g.lh + 1, g.h - 2);
      is(`${w} ${name}: the box's hint is drawn on one line`, '1 line',
         g.typed ? 'the box is not empty' : on <= 0 ? `no hint drawn ("${g.hint}")` : below ? `${below} px of it below the first line ("${g.hint}")` : '1 line');
      if (w === 390 && name === 'lead session') await shot('hint');
    }
    await open('#/p/acme-api/s/docs-pass');
    await until(() => !!document.querySelector('.composer textarea'));
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    // Six lines: past the four a phone's box grows to (2c below), so it scrolls and the insets are asked.
    await b.call('Input.insertText', { text: 'a quick reply going\npast the four lines\nthe box grows to\nso that it\nhas to scroll\nthe rest' });
    await sleep(300);
    const g = await boxAt();
    is(`${w} six lines in the box: it scrolls`, true, g.max > 0 || `scrolls ${g.max} px`);
    const into = { top: [], bottom: [] };
    for (let s = 0; s <= g.max; s += 2) {
      await b.evaluate((x) => { document.querySelector('.composer textarea').scrollTop = x; }, s);
      await sleep(40);
      const top = await ink('.composer textarea', 2, g.first - 1), foot = await ink('.composer textarea', g.h - g.first + 1, g.h - 2);
      if (top) into.top.push(`${top} px scrolled ${s}`);
      if (foot) into.bottom.push(`${foot} px scrolled ${s}`);
    }
    const said = (k) => into[k].length ? `${into[k].length} of ${Math.floor(g.max / 2) + 1} scrolls, e.g. ${into[k].slice(-2).join(', ')}` : '';
    is(`${w} ...and no text is drawn in its top inset, at any scroll`, '', said('top'));
    is(`${w} ...nor in its bottom inset`, '', said('bottom'));
    if (w === 390) await shot('three-lines');
    await b.evaluate(() => { const n = document.querySelector('.composer textarea'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); n.blur(); });
  }
  await b.viewport(W, H);

  // ── 2c. at rest the box is one line, its buttons' height, and only typing grows it ──
  // Reported from the installed iPhone app: "the chat button is taller than the mic attach and
  // send". The box was its two rows, 68 px at 16px, beside three 46 px buttons. Asked at the three
  // widths a phone is, in both languages (the language is read at load, so a reload past the lock
  // in each), on a session with a request open as well, whose cover has to say itself in that
  // height: at 320 "Answer the request" went a word a line and the last one was cut.
  const relang = async (l) => {
    await b.evaluate((x) => { if (x) localStorage.setItem('gfw.lang', x); else localStorage.removeItem('gfw.lang'); }, l);
    await b.evaluate(() => location.reload());
    await sleep(300);
    await until(() => [...document.querySelectorAll('.auth-card button')].some(x => /without a passkey|sin llave/i.test(x.textContent)));
    await b.evaluate(() => [...document.querySelectorAll('.auth-card button')].find(x => /without a passkey|sin llave/i.test(x.textContent))?.click());
    await until(() => !!document.querySelector('.app'));
  };
  const rest = () => b.evaluate(() => {
    const t = document.querySelector('.composer textarea'), cs = getComputedStyle(t);
    const btns = [...document.querySelectorAll('.composer .composer-row > button')].filter(x => x.getClientRects().length)
      .map(x => Math.round(x.getBoundingClientRect().height * 10) / 10);
    const h = Math.round(t.getBoundingClientRect().height * 10) / 10, f = parseFloat(cs.fontSize);
    return `box ${h}, buttons ${[...new Set(btns)].join('/')}, text ${f >= 16 ? '16px or more' : cs.fontSize}`;
  });
  for (const lang of ['en', 'es']) {
    await relang(lang);
    for (const w of [320, 390, 430]) {
      await b.viewport(w, H);
      await open('#/p/acme-api/s/docs-pass');
      await until(() => !!document.querySelector('.composer textarea')?.placeholder);
      is(`${w} ${lang} session: the box at rest is one line, its buttons' height`, 'box 46, buttons 46, text 16px or more', await rest());
      const g = await boxAt();
      const below = await ink('.composer textarea', g.first + g.lh + 1, g.h - 2), above = await ink('.composer textarea', 2, g.first - 1);
      is(`${w} ${lang} session: ...and its hint is drawn on one line inside it`, '1 line',
         g.typed ? 'the box is not empty' : below || above ? `${above} px above its line, ${below} below ("${g.hint}")` : '1 line');
      if (w === 390) await shot(`box-rest-${lang}`);
      await open('#/p/acme-api/s/api-fix');
      await until(() => !!document.querySelector('.composer .request-return'));
      await b.evaluate(() => document.querySelector('[role=dialog] .x, .modal .x')?.click());
      await sleep(200);
      is(`${w} ${lang} session with a request: the box is the same height under its cover`, 'box 46, buttons 46, text 16px or more', await rest());
      // Its LINES against its edges, not scrollHeight: the cover centres its words, so a third line
      // overflows above as much as below, and what runs over the top is in no scrollHeight.
      is(`${w} ${lang} session with a request: ...and the cover says itself inside it`, 'fits', await b.evaluate(() => {
        const c = document.querySelector('.composer .request-return'), r = c.getBoundingClientRect(), cs = getComputedStyle(c);
        const top = r.top + parseFloat(cs.borderTopWidth), foot = r.bottom - parseFloat(cs.borderBottomWidth);
        const words = document.createRange(); words.selectNodeContents(c);
        const out = [...words.getClientRects()].filter(x => x.width && x.height && (x.top < top - 0.5 || x.bottom > foot + 0.5));
        return out.length ? `${out.length} of its lines past its edge, by ${Math.round(Math.max(...out.map(x => Math.max(top - x.top, x.bottom - foot))))} px ("${c.textContent.trim()}")` : 'fits';
      }));
      if (w === 320) await shot(`box-request-${lang}`);
    }
    // Typing grows it a line at a time to four, after which it scrolls, and an emptied box (a send
    // empties it) is one line again. The step is the box's own line, so the row holds at any size.
    await b.viewport(W, H);
    await open('#/p/acme-api/s/docs-pass');
    await until(() => !!document.querySelector('.composer textarea'));
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    const seen = [await boxAt()];
    for (const line of ['one line', '\nand a second', '\na third', '\na fourth', '\na fifth']) {
      await b.call('Input.insertText', { text: line });
      await sleep(150);
      seen.push(await boxAt());
      if (lang === 'en' && seen.length === 4) await shot('box-three-lines');
    }
    await b.evaluate(() => { const n = document.querySelector('.composer textarea'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(150);
    const emptied = await boxAt();
    const lh = seen[0].lh, [r0, l1, l2, l3, l4, l5] = seen.map(x => Math.round(x.h));
    const grew = l1 === r0 && l2 === r0 + lh && l3 === r0 + 2 * lh && l4 === r0 + 3 * lh && l5 === l4 && seen[5].max > 0 && seen[4].max <= 0 && Math.round(emptied.h) === r0;
    is(`${W} ${lang} session: typing grows the box a line at a time to four, then it scrolls, and emptied it is one line again`, 'so',
       grew ? 'so' : `${seen.map(x => Math.round(x.h) + (x.max > 0 ? ` (scrolls ${x.max})` : '')).join(' -> ')}, emptied ${Math.round(emptied.h)}`);
    await b.evaluate(() => document.activeElement?.blur?.());
  }
  await relang(null);
  await b.viewport(W, H);

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
  // A finger: down at (x, y), twelve moves to (x+dx, y+dy), up. Raw touch points, not
  // Input.synthesizeScrollGesture: on Linux a synthesized touch scroll delivers its pointer and
  // touch events and scrolls NOTHING, not even a page built to move, so every "moves nothing" row
  // below passed there on whatever code it was given. It is also never cancelled, so the chat's
  // own swipe read the gesture as a step to the next session. Raw touch points pan a page and
  // scroll a box on Linux and macOS alike, and the browser cancels the pointer as a real pan does.
  // The end may lie past the screen's edge: a finger leaving the screen is tracked on both.
  const swipe = async (x, y, dx, dy) => {
    const n = 12;
    await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= n; i++) {
      await b.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / n, y: y + dy * i / n }] });
      await sleep(16);
    }
    await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
  // ...and the measurement is not blind: the same swipes on a page that CAN move say it moved, on
  // each axis, each from a page measured still first. This is the row that found the swipes blind
  // on Linux; without it the rows above read green there on any code.
  await open('#/');
  const saw = [];
  for (const [label, x, y, dx, dy] of [['up on the top bar', 200, 24, 0, -300], ['left on the page', 200, 420, -250, 0]]) {
    await b.evaluate(() => {
      const s = document.createElement('style'); s.id = 'fit-undo';
      // The shell undone, and the scrollers' `contain` with it: a finger inside .main chains to
      // the page only when nothing between them holds the pan.
      s.textContent = '#app { position: static !important; overflow: visible !important; height: auto !important; } html, body { overflow: visible !important; height: auto !important; } .app { height: auto !important; grid-template-columns: 1fr !important; } *, html, body { overscroll-behavior: auto !important; }';
      document.head.append(s);
      const d = document.createElement('div'); d.id = 'fit-big'; d.style.cssText = 'width:1400px;height:2600px'; document.querySelector('.app').appendChild(d);
    });
    await sleep(100);
    const from = await where();
    await swipe(x, y, dx, dy);
    const to = await where();
    if (from !== STILL || to === STILL) saw.push(`${label}: ${from} → ${to}`);
    await b.evaluate(() => { document.getElementById('fit-undo')?.remove(); document.getElementById('fit-big')?.remove(); scrollTo(0, 0); });
    await b.call('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
    await sleep(150);
  }
  is('...and a swipe on a page that can move is seen moving it, on each axis', '', saw.join('; '));

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

  // ── 5. the Assistant button floats above a composer, never on it ───────────
  // Seen in this file's own shot: the button over the box's top-right corner, the words being
  // typed running under it, because its height over a composer was a guess the taller touch box
  // outgrew; at a desk it sat on a stack column's mic. It goes 8 px above the composer's real
  // top, and the chat under it leaves room for its newest message to scroll clear. With the
  // keyboard up it is not drawn at all (kbRead, below). Asked of the button's whole dock (Done and Stop sit in it while a conversation is
  // live) against every composer control and every text field on the screen, and of the chat the
  // button is over, not the first one found: a desk's stack has three.
  const STACK = (s) => `#/stack/${encodeURIComponent(JSON.stringify(s.map(session => ({ project: 'acme-api', session }))))}`;
  const dockRead = () => b.evaluate(() => {
    const dock = document.querySelector('.as-dock');
    if (!dock) return { cover: 'no button', gap: 'no button', chat: 'no button', kb: false };
    const D = dock.getBoundingClientRect();
    const across = (r) => r.width > 0 && r.height > 0 && r.left < D.right - 0.5 && r.right > D.left + 0.5;
    const hit = (r) => across(r) && r.top < D.bottom - 0.5 && r.bottom > D.top + 0.5;
    const name = (el) => el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent.trim().slice(0, 24) || el.tagName.toLowerCase();
    const controls = [...document.querySelectorAll('.composer button, .composer textarea, .composer input, .composer select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, [contenteditable="true"]')]
      .filter(el => !dock.contains(el) && !el.closest('.assistant') && getComputedStyle(el).visibility !== 'hidden');
    const cover = [...new Set(controls.filter(el => hit(el.getBoundingClientRect())).map(name))].join(' | ') || 'none';
    const under = [...document.querySelectorAll('.composer')].map(c => c.getBoundingClientRect()).filter(across);
    const gap = under.length ? `${Math.round(Math.min(...under.map(r => r.top)) - D.bottom)} px` : 'no composer under it';
    const c = [...document.querySelectorAll('.chat')].find(x => across(x.getBoundingClientRect()));
    let chat = 'no chat under it';
    if (c) {
      // Where a reader can take it: the page to its end as well as the chat. With the keyboard up
      // a session can be taller than .main, and its sticky composer covers the chat's foot until
      // .main is scrolled, as the main run's clear() also does.
      const main = document.querySelector('.main');
      if (main) main.scrollTop = main.scrollHeight;
      c.scrollTop = c.scrollHeight;
      const m = [...c.querySelectorAll('.msg')].pop(), R = m?.getBoundingClientRect();
      chat = !m ? 'no message' : hit(R) ? `under the button by ${Math.round(R.bottom - D.top)} px` : 'clear';
    }
    return { cover, gap, chat, kb: document.documentElement.classList.contains('kb') };
  });
  const launchRows = async (label) => {
    const r = await dockRead();
    is(`${label}: the Assistant button covers no composer control and no text field`, 'none', r.cover);
    is(`${label}: ...its bottom edge 8 px above the composer under it`, '8 px', r.gap);
    is(`${label}: ...and the newest message scrolls clear of it`, 'clear', r.chat);
  };
  // WITH THE KEYBOARD UP the chat left on a phone is a strip about 140pt tall (seen on the
  // simulator), and the button covered a third of it. So it is not drawn, and the chat gives back
  // the room it kept for it: the newest message sits exactly where it sits with the button taken
  // out of the page and nothing else changed (taken out, measured and put back in one task, so
  // nothing renders in between). The chat is the one being typed into, a stack's column's own.
  // `end` is read FIRST, before this scrolls anything: a reader at the end when the keyboard came
  // up is still there, so the room going did not move what they were reading.
  const chatOf = () => document.activeElement?.closest?.('.session')?.querySelector('.chat') || document.querySelector('.chat');
  const kbRead = () => b.evaluate((chatOfSrc) => {
    const chatOf = eval(chatOfSrc), c = chatOf();
    const dock = document.querySelector('.as-dock');
    const kb = document.documentElement.classList.contains('kb');
    if (!c || !dock) return { kb, drawn: !dock ? 'no button' : 'drawn', end: 'no chat', same: 'no chat' };
    const end = c.scrollHeight - c.clientHeight - c.scrollTop < 2 ? 'at the end' : `${Math.round(c.scrollHeight - c.clientHeight - c.scrollTop)} px short of the end`;
    const drawn = dock.getClientRects().length && getComputedStyle(dock).visibility !== 'hidden' ? `drawn, ${Math.round(dock.getBoundingClientRect().height)} px tall` : 'not drawn';
    const main = document.querySelector('.main');
    const toEnd = () => { if (main) main.scrollTop = main.scrollHeight; c.scrollTop = c.scrollHeight; };
    const last = () => { const m = [...c.querySelectorAll('.msg')].pop(), r = m?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : 'none'; };
    toEnd();
    const withIt = last();
    const parent = dock.parentNode, next = dock.nextSibling;
    dock.remove(); toEnd();
    const gone = last();
    parent.insertBefore(dock, next); toEnd();
    return { kb, drawn, end, same: withIt === gone ? 'the same' : `${withIt} beside the button, ${gone} with it gone` };
  }, chatOf.toString());
  const endRead = () => b.evaluate((chatOfSrc) => {
    const c = eval(chatOfSrc)(), dock = document.querySelector('.as-dock');
    if (!c || !dock) return 'no chat';
    const short = Math.round(c.scrollHeight - c.clientHeight - c.scrollTop);
    const D = dock.getBoundingClientRect(), m = [...c.querySelectorAll('.msg')].pop()?.getBoundingClientRect();
    const under = m && D.height && m.left < D.right && m.right > D.left && m.top < D.bottom && m.bottom > D.top;
    return short >= 2 ? `${short} px short of the end` : !D.height ? 'no button' : under ? `under the button by ${Math.round(m.bottom - D.top)} px` : 'at the end, clear of the button';
  }, chatOf.toString());
  for (const w of [320, 390]) {
    await b.viewport(w, H);
    // The session with a request open is asked with the keyboard down only: its box is behind
    // "Answer the request", a tap there opens the request, and no keyboard comes up from it.
    for (const [name, hash, typed = true] of [['lead session', '#/p/acme-api/s/master'], ['session with a request', '#/p/acme-api/s/api-fix', false],
      ['quiet session', '#/p/acme-api/s/docs-pass'], ['stack', STACK(['master', 'docs-pass'])]]) {
      await open(hash);
      await until(() => !!document.querySelector('.composer textarea') && !!document.querySelector('.as-dock'));
      await sleep(300);
      // ...which leaves the chat scrolled to its end: the reader the keyboard rows follow.
      await launchRows(`${w} ${name}, keyboard down`);
      if (w === 390 && name === 'lead session') await shot('launch-down');
      if (!typed) continue;
      await b.evaluate(() => { document.querySelector('.composer textarea')?.focus(); window.__vv?.(431); });
      await sleep(400);
      const r = await kbRead();
      const label = `${w} ${name}, keyboard up`;
      is(`${label}: ...the keyboard is up (the app pinned to the visible 431 px)`, true, r.kb);
      is(`${label}: a reader at the end is still at the end`, 'at the end', r.end);
      is(`${label}: the Assistant button is not drawn`, 'not drawn', r.drawn);
      is(`${label}: ...and the newest message sits where it does with no button at all`, 'the same', r.same);
      if (w === 390 && name === 'lead session') await shot('launch-up');
      await b.evaluate(() => { document.activeElement?.blur?.(); window.__vv?.(null); });
      await sleep(400);
      is(`${w} ${name}, keyboard gone: the button is back, the reader still at the end and clear of it`, 'at the end, clear of the button', await endRead());
    }
  }
  await b.viewport(W, H);
  await touch(false);
  // ...and at a desk, with a mouse: the lead's chat, and a stack of three whose right column the
  // button sat over, its mic under the button.
  await b.viewport(1280, 900);
  for (const [name, hash] of [['lead session', '#/p/acme-api/s/master'], ['stack', STACK(['master', 'types', 'docs-pass'])]]) {
    await open(hash);
    await until(() => !!document.querySelector('.composer textarea') && !!document.querySelector('.as-dock'));
    await sleep(400);
    await launchRows(`1280 ${name}`);
    if (name === 'stack') await shot('launch-desk-stack');
  }
  await b.viewport(W, H);

  // ── 6. a connected keyboard: pinned, and its ⏎ still sends ─────────────────
  // With a hardware keyboard iOS shows a bar of about 64pt and pans the visual viewport about 68pt
  // to show the box over it, which took the top bar off the screen (seen on the simulator).
  // viewport.js pins the app for that too (phone-check.mjs asks the geometry). It is a pin and not
  // an on-screen keyboard: the first key typed marks a keyboard someone attached, and ⏎ sends
  // (keys.js). A probe that answered "keyboard up" for the pin would make ⏎ a new line under the
  // owner's fingers. LAST in this run, because that mark is the page's for the rest of its life.
  await touch(true);
  await open('#/p/acme-api/s/docs-pass');
  await until(() => !!document.querySelector('.composer textarea'));
  await b.evaluate(() => { document.querySelector('.composer textarea').focus(); window.__vv?.(776, 68); });
  await sleep(200);
  const pinned = await b.evaluate(() => document.documentElement.classList.contains('kb'));
  for (const [key, code, vk, text] of [['k', 'KeyK', 75, 'k'], ['Enter', 'Enter', 13, '\r']]) {
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  }
  await sleep(700);
  const left = await b.evaluate(() => document.querySelector('.composer textarea').value);
  is(`${W} a connected keyboard's bar: the app is pinned, and ⏎ sends what was typed`, 'pinned, sent',
     `${pinned ? 'pinned' : 'not pinned'}, ${left === '' ? 'sent' : `the box holds ${JSON.stringify(left)}`}`);
  await b.evaluate(() => { document.activeElement?.blur?.(); window.__vv?.(null); });
  await touch(false);
}
