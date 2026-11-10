// The cursor says what a press will do. The browser's `cursor: auto` is an I-beam over any text,
// so the sidebar's usage meters, the person's own name at its foot and every heading and label
// offered to be typed in or selected, and a double-click on one selected it. Now the chrome is
// the plain arrow and selects nothing, everything that takes a press is the pointer (not-allowed
// when it is disabled, grab when it is dragged), and the I-beam is left where text is typed or
// is worth copying: the inputs, and the messages, code, logs and errors, which select again.
//
// A screen is read whole rather than sampled: every element the browser treats as a control,
// and every element a click handler was attached to (seen by wrapping addEventListener before
// the app loads, which is how the screens attach theirs), and every element that shows text of
// its own. A sample would pass on the next screen nobody thought to list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { sleep } from '../../../lib/browser.mjs';

const SCREENS = [
  ['home', '/', '.home-agent'],
  ['session', '/p/acme-web/s/onboarding', '.sess-head'],
  ['project', '/p/acme-web', '.card'],
  ['map', '/map', '.ocean .boat'],
  ['settings', '/settings', '.main h1'],
  ['admin: people', '/admin/users', '.main h1'],
  ['admin: AI account', '/admin/ai', '.main h1'],
  ['admin: usage', '/admin/usage', '.main h1'],
  ['automations', '/automations', '.main h1'],
  ['automation editor', '/automations/new', '.palette'],
  ['activity', '/activity', '.main h1'],
];

const CLICKS = `(() => {
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const n = new WeakMap();
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (type === 'click' && this instanceof Element) n.set(this, (n.get(this) || 0) + 1);
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    if (type === 'click' && this instanceof Element && n.get(this)) n.set(this, n.get(this) - 1);
    return rem.call(this, type, fn, o);
  };
  window.__clicks = (el) => (n.get(el) || 0) > 0;
})();`;

// Everything on screen, judged. Returns the elements that are wrong, by kind, named the way a
// person would find them: tag, classes, and the words on it.
function audit() {
  const CONTROL = 'button, a[href], summary, select, [role=button], [role=tab], [role=option], [role=menuitem], [role=menuitemradio], [role=switch], '
    + 'input:is([type=checkbox], [type=radio]), label:has(input:is([type=checkbox], [type=radio]))';
  const TYPED = 'input:not([type=checkbox], [type=radio], [type=hidden], [type=range], [type=color], [type=file], [type=button], [type=submit]), textarea, [contenteditable]:not([contenteditable=false])';
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const words = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${cls}${words ? ` "${words}"` : ''}`;
  };
  // Text people copy: the element, or one above it, selects text again.
  const sel = new Map();
  const readable = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (sel.has(e)) { const v = sel.get(e); if (v !== null) return v; continue; }
      const u = getComputedStyle(e).userSelect;
      const v = u === 'text' || u === 'all' ? true : null;
      sel.set(e, v);
      if (v) return true;
    }
    return false;
  };
  const isControl = (el) => el.matches(CONTROL) || window.__clicks(el);
  const out = { click: [], chrome: [], typed: [], controls: 0, texts: 0, inputs: 0 };
  const add = (list, s) => { if (!list.includes(s)) list.push(s); };
  for (const el of document.querySelectorAll('body *')) {
    if (!seen(el)) continue;
    const c = getComputedStyle(el).cursor;
    if (isControl(el)) {
      out.controls++;
      const off = el.matches(':disabled, [aria-disabled=true]') || !!el.closest('fieldset:disabled');
      const want = off ? ['not-allowed'] : el.matches('[draggable=true]') ? ['grab', 'grabbing'] : ['pointer'];
      if (!want.includes(c)) add(out.click, `${name(el)} is "${c}", not "${want[0]}"${off ? ' (disabled)' : ''}`);
      continue;
    }
    if (el.matches(TYPED)) {
      out.inputs++;
      const want = el.matches(':disabled') ? 'not-allowed' : 'text';
      if (c !== want) add(out.typed, `${name(el)} is "${c}", not "${want}"`);
      continue;
    }
    // Words of its own, outside anything pressed, typed in or copied from: chrome.
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own || el.closest(`${CONTROL}, ${TYPED}`)) continue;
    let pressed = false;
    for (let e = el.parentElement; e && !pressed; e = e.parentElement) pressed = window.__clicks(e);
    if (pressed || readable(el)) continue;
    out.texts++;
    if (c !== 'default') add(out.chrome, `${name(el)} is "${c}", not "default"`);
  }
  return out;
}

// The middle of the first word of the first text inside `sel`, for a double-click on it.
function wordAt(sel) {
  const root = document.querySelector(sel);
  if (!root) return null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/\w{3,}/.test(n.textContent) ? 1 : 3) });
  const node = walk.nextNode();
  if (!node) return null;
  const m = /\w{3,}/.exec(node.textContent);
  const range = document.createRange();
  range.setStart(node, m.index);
  range.setEnd(node, m.index + m[0].length);
  const r = range.getBoundingClientRect();
  return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, word: m[0] } : null;
}

test('desk 1440×900: the arrow on chrome, the pointer on what takes a press, the I-beam where text is typed or copied', { timeout: 300000 }, async (t) => {
  const { b, go, click, press } = await browse(t, { width: 1440, height: 900 });
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: CLICKS });
  const problems = [];
  const want = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
  const list = (screen, kind, items) => {
    if (items.length) problems.push(`${screen}: ${items.length} ${kind}:\n      ${items.slice(0, 12).join('\n      ')}${items.length > 12 ? `\n      … and ${items.length - 12} more` : ''}`);
  };
  const judge = async (screen) => {
    const a = await b.evaluate(audit);
    want(a.controls >= 3 && a.texts >= 3, `${screen}: read only ${a.controls} controls and ${a.texts} texts: the screen did not draw`);
    list(screen, 'controls without the pointer', a.click);
    list(screen, 'chrome texts without the arrow', a.chrome);
    list(screen, 'fields without the I-beam', a.typed);
    t.diagnostic(`${screen}: ${a.controls} controls, ${a.texts} chrome texts, ${a.inputs} fields`);
    return a;
  };
  const cursor = (s) => b.evaluate((x) => { const el = document.querySelector(x); return el ? getComputedStyle(el).cursor : null; }, s);
  const mouse = async (type, x, y, n = 1) => b.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: n });
  const dblclick = async (p) => {
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await mouse('mousePressed', p.x, p.y, 1); await mouse('mouseReleased', p.x, p.y, 1);
    await mouse('mousePressed', p.x, p.y, 2); await mouse('mouseReleased', p.x, p.y, 2);
    await sleep(150);
  };
  const selected = () => b.evaluate(() => String(getSelection()).trim());
  const unselect = () => b.evaluate(() => getSelection().removeAllRanges());

  // What people copy from selects again, wherever a screen shows it
  const COPY = ['.msg .bubble', '.md', 'pre', '.err', '.notice', '.as-feed .as-row:not(.go)', '.ai-msg', '.tk-more', '.log-detail', '.log-out', '.run-step', '.temp-pw'];
  const copied = new Set();
  const copyable = async (screen) => {
    const found = await b.evaluate((sels) => sels.flatMap(s => [...document.querySelectorAll(s)]
      .filter(e => e.getBoundingClientRect().width && !e.closest('.card, button, a[href], summary')).slice(0, 1)
      .map(e => [s, getComputedStyle(e).userSelect])), COPY);
    for (const [s, u] of found) { copied.add(s); want(u !== 'none', `${screen}: ${s}, which people copy from, selects nothing (user-select: none)`); }
  };

  let audited = 0;
  for (const [screen, route, ready] of SCREENS) {
    try { await go(route, ready); } catch { want(false, `${screen}: ${route} never showed ${ready}`); continue; }
    await sleep(700);
    // the activity log's first entry, open: its detail and output are what is read there
    if (screen === 'activity') await b.evaluate(() => { const d = [...document.querySelectorAll('.log-row')].find(x => x.querySelector('.log-detail, .log-out')); if (d) d.open = true; });
    const a = await judge(screen);
    await copyable(screen);
    audited += a.controls + a.texts;

    if (screen === 'home') {
      // the owner's two: the usage meters and the person's row at the sidebar's foot
      for (const s of ['.usage .usage-head', '.usage-acc', '.side-foot .grow', '.side-sec', '.main h1, .home-agent h2', '.lg']) {
        const c = await b.evaluate((x) => {
          const el = [...document.querySelectorAll(x)].find(e => e.getBoundingClientRect().width);
          if (!el) return null;
          const leaf = [...el.querySelectorAll('*')].concat(el).find(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
          return getComputedStyle(leaf || el).cursor;
        }, s);
        want(c === 'default', `home: ${s} shows the "${c}" cursor, not the arrow`);
      }
      for (const s of ['.side-foot a.icon-btn', '.side-foot button.icon-btn']) want((await cursor(s)) === 'pointer', `home: ${s} (the gear and the logout) shows "${await cursor(s)}", not the pointer`);
      // a double-click or a drag over the sidebar's labels selects nothing
      await unselect();
      const w = await b.evaluate(wordAt, '.usage .usage-head');
      if (want(w, 'home: no words in the usage block to double-click')) {
        await dblclick(w);
        want(!(await selected()), `home: a double-click on "${w.word}" in the usage block selected ${JSON.stringify(await selected())}`);
      }
      const from = await b.evaluate(wordAt, '.side-sec'), to = await b.evaluate(wordAt, '.side-foot .grow');
      if (want(from && to, 'home: no sidebar heading or user row to drag across')) {
        await unselect();
        await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - 20, y: from.y });
        await mouse('mousePressed', from.x - 20, from.y);
        for (let i = 1; i <= 6; i++) await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6, buttons: 1 });
        await mouse('mouseReleased', to.x, to.y);
        await sleep(150);
        want(!(await selected()), `home: a drag down the sidebar selected ${JSON.stringify((await selected()).slice(0, 60))}`);
      }
      // a field still types and selects inside a page that selects nothing
      await click('.home-agent form input');
      await b.call('Input.insertText', { text: 'check the payment tests' });
      const f = await b.evaluate(() => { const r = document.querySelector('.home-agent form input').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
      await dblclick(f);
      const range = await b.evaluate(() => { const i = document.querySelector('.home-agent form input'); return i.selectionEnd - i.selectionStart; });
      want(range > 0, 'home: a double-click in the assistant\'s field selects nothing in it');
      // ...and said: what the person and the assistant said is copied from, on the card
      await b.evaluate(() => document.querySelector('.home-agent form input').setSelectionRange(99, 99));
      await press('Enter');
      for (let i = 0; i < 50 && !(await b.evaluate(() => !!document.querySelector('.home-agent .as-feed .as-row.me'))); i++) await sleep(100);
      await copyable('home, after a message');
      // A lead's reply opens its session on a press, so it is one press target; the demo sends
      // none in a test's time, so a row of each kind is put in the feed and read
      const rows = await b.evaluate(() => {
        const feed = document.querySelector('.home-agent .as-feed');
        if (!feed) return null;
        const out = {};
        for (const cls of ['as-row ai go', 'as-row ai', 'as-row event go', 'as-row event bad']) {
          const d = document.createElement('div'); d.className = cls; d.textContent = 'acme-web lead: the payment tests pass';
          feed.append(d); const c = getComputedStyle(d); out[cls] = [c.cursor, c.userSelect]; d.remove();
        }
        return out;
      });
      if (want(rows, 'home: the card has no feed')) {
        for (const cls of ['as-row ai go', 'as-row event go']) want(rows[cls][0] === 'pointer' && rows[cls][1] === 'none', `home: a feed row that opens its session (${cls}) is ${rows[cls].join(' / ')}, not pointer / none`);
        for (const cls of ['as-row ai', 'as-row event bad']) want(rows[cls][1] !== 'none', `home: a feed row that opens nothing (${cls}) selects nothing`);
        want(rows['as-row event bad'][0] !== 'pointer', 'home: an error in the feed, which opens nothing, shows the pointer');
      }
      // the "Talking to" label shows the pointer because a press on it is a press on the field
      const open = () => b.evaluate(() => !!document.querySelector('.select-list'));
      const lab = await b.evaluate(() => { const c = document.querySelector('.home-agent .talk-to [role=combobox]'), l = c && document.getElementById(c.getAttribute('aria-labelledby')); if (l) l.setAttribute('data-t', 'label'); return !!l; });
      if (want(lab, 'home: the "Talking to" picker has no label')) {
        await click('[data-t=label]');
        want(await open(), 'home: a press on the "Talking to" label did not open its list');
        await click('[data-t=label]');
        want(!(await open()), 'home: a second press on the "Talking to" label left the list open');
      }
      // a ship's card, open: chrome, but the last thing the session said selects
      const ship = await b.evaluate(() => { const r = [...document.querySelectorAll('a.fboat')].find(x => x.getBoundingClientRect().width)?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (want(ship, 'home: no ship on the board to hover')) {
        await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ship.x, y: ship.y });
        let said = null;
        for (let i = 0; i < 30 && !said; i++) { await sleep(100); said = await b.evaluate(() => { const e = document.querySelector('.ship-tip .tip-said'); return e && getComputedStyle(e).userSelect; }); }
        if (want(said, 'home: hovering a ship opened no card with what it said')) {
          await judge('home, a ship\'s card open');
          want(said !== 'none', 'home: what a session said, on its ship\'s card, selects nothing');
        }
        await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1430, y: 890 });
        await sleep(400);
      }
      // an open list: its options take a press
      await click('.home-agent .talk-to .select');
      if (want(await b.evaluate(() => !!document.querySelector('.select-list [role=option]')), 'home: the "Talking to" list did not open')) await judge('home, "Talking to" open');
      await press('Escape');
    }

    if (screen === 'session') {
      // the conversation is read and copied from: a double-click selects a word of it
      await unselect();
      const w = await b.evaluate(wordAt, '.msg:not(.me) .bubble, .msg .bubble');
      if (want(w, 'session: no message to double-click')) {
        await dblclick(w);
        want((await selected()) === w.word, `session: a double-click on "${w.word}" in a message selected ${JSON.stringify(await selected())}`);
      }
      want(['text', 'auto'].includes(await cursor('.msg .bubble')), `session: a message shows "${await cursor('.msg .bubble')}", not the I-beam`);
      want((await cursor('textarea')) === 'text', `session: the composer shows "${await cursor('textarea')}", not the I-beam`);
      await unselect();
      // the More menu, open
      const more = await b.evaluate(() => { const m = [...document.querySelectorAll('.sess-head button')].find(x => /More/.test(x.textContent)); if (m) m.id = 't-more'; return !!m; });
      if (want(more, 'session: no More button')) {
        await click('#t-more');
        if (want(await b.evaluate(() => !!document.querySelector('.menu')), 'session: More did not open')) await judge('session, More open');
        await press('Escape');
      }
    }
  }
  want(audited > 500, `only ${audited} elements were judged across ${SCREENS.length} screens`);
  t.diagnostic(`copied from: ${[...copied].join(', ')}`);
  want(copied.size >= 3, `only ${[...copied].join(', ') || 'nothing'} of the text people copy from was on any screen`);
  assert.deepEqual(problems, []);
});
