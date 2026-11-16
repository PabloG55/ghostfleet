// test/helpers/send-scroll.mjs — a message sent from up a conversation is seen going in. Run from
// phone-check.mjs: in its main run, and alone with `--send-only`.
//
// Reported from the phone: "if you send a message it should scroll all the way down to the sent
// message". The chat followed its end only for a reader already there, so a message sent while
// reading older turns went in below the fold, and the chat stayed where it was with nothing on
// screen to say it had gone. The assistant's feed did follow every new row, until it was full: it
// keeps its last 61, and its jump was keyed on the count, which stops changing at the 61st.
//
// Each case scrolls its conversation up first and says it did (the newest row out of view), then
// sends, and looks for what was sent inside the scroller's visible rect, with the window and the
// frame's own scroller where they were: the conversation's box is what moves, never the page.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../lib/browser.mjs';

export async function sendScroll({ b, is, shots = '' }) {
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `send-${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (fn, a, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await b.evaluate(fn, a).catch(() => null); if (v) return v; await sleep(50); }
    return null;
  };
  // Where a row is against its scroller's visible rect, and whether anything else moved.
  const seen = (box, row) => b.evaluate(([bs, rs]) => {
    const box = document.querySelector(bs), row = [...document.querySelectorAll(rs)].pop();
    if (!box || !row) return `no ${box ? 'row' : 'box'}`;
    const B = box.getBoundingClientRect(), R = row.getBoundingClientRect();
    // On the screen as well as inside the box: a box that has stopped being the scroller is as
    // tall as everything in it, and would hold every row "in view" of itself.
    const inBox = R.top >= B.top - 1 && R.bottom <= B.bottom + 1, onScreen = R.top >= -1 && R.bottom <= innerHeight + 1;
    return inBox && onScreen ? 'in view' : `${Math.round(R.top - B.top)} px from the top of a ${Math.round(B.height)} px box, ${Math.round(R.top)} px down a ${innerHeight} px screen`;
  }, [box, row]);
  const page = () => b.evaluate(() => `window ${Math.round(scrollX)},${Math.round(scrollY)} · main ${Math.round(document.querySelector('.main')?.scrollTop || 0)}`);
  const type = async (sel, text) => {
    await b.evaluate((s) => document.querySelector(s)?.focus(), sel);
    await b.call('Input.insertText', { text });
    await sleep(60);
  };
  const W = 390;
  await b.viewport(W, 844);

  // ── the session's chat ─────────────────────────────────────────────────────
  await b.evaluate(() => { location.hash = '#/p/acme-api/s/master'; });
  await until(() => document.querySelectorAll('.chat .msg').length > 2);
  await sleep(600);
  const room = await b.evaluate(() => { const c = document.querySelector('.chat'); return c.scrollHeight - c.clientHeight; });
  is(`${W} the lead's chat is long enough to scroll up in`, true, room > 120 || `only ${room} px`);
  await b.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); });
  await sleep(400);
  is(`${W} ...and scrolled to its top, its newest message is out of view`, true,
     (await seen('.chat', '.chat .msg')) !== 'in view');
  const before = await page();
  const SAID = 'sent while reading the top of the chat';
  await type('.composer textarea', SAID);
  await b.evaluate(() => document.querySelector('.composer button[type=submit]')?.click());
  const landed = await until((s) => [...document.querySelectorAll('.chat .msg.me')].some(m => m.textContent.includes(s)), SAID);
  is(`${W} the message sent lands in the chat`, true, !!landed);
  await sleep(500);
  is(`${W} a message sent from the top of the chat is in view in the chat`, 'in view', await seen('.chat', '.chat .msg.me'));
  is(`${W} ...and it is the chat that scrolled, not the window or the frame`, before, await page());
  await shot('session');

  // ── the assistant's feed, full ─────────────────────────────────────────────
  await b.evaluate(() => { location.hash = '#/p/acme-api'; });
  await sleep(900);
  await b.evaluate(() => document.querySelector('.as-launch')?.click());
  is(`${W} the assistant panel opens, with its box`, true, !!(await until(() => !!document.querySelector('.assistant .console input'))));
  const send = async (text) => {
    await type('.assistant .console input', text);
    await b.evaluate(() => document.querySelector('.assistant .console form')?.requestSubmit());
    await sleep(40);
  };
  // The same words again within 20 seconds are answered on the spot (agent.js heard: your row and
  // a notice), so the feed fills to its cap with no round trip to wait for.
  const FILL = 'what is waiting on me';
  await send(FILL);
  await until(() => document.querySelectorAll('.assistant .as-feed .as-row').length >= 2);
  for (let i = 0; i < 32; i++) await send(FILL);
  const rows = await until(() => { const n = document.querySelectorAll('.assistant .as-feed .as-row').length; return n >= 61 && n; });
  is(`${W} ...and its feed is full: the 61 rows it keeps`, true, rows >= 61 || `only ${rows} rows`);
  // The first message is answered by the daemon on its own time: its chain (find the lead, hand
  // the message over) can push a row long after the 61st was counted, and the feed follows every
  // row to its end. A scroll to the top that comes before that row is undone by it, and the newest
  // row is "in view" again. So the feed is scrolled up only once it has stopped: the same last row
  // and the feed at its end for a third of a second, and no hand-over still in flight.
  // LATE_ROW=1 forces the race on demand: a row lands 150 ms from now, as a late answer would.
  const late = process.env.LATE_ROW ? sleep(150).then(() => send('something else entirely')) : null;
  if (!process.env.LATE_ROW_NO_SETTLE) {
    let still = 0, last = '';
    const end = Date.now() + 8000;
    while (still < 6 && Date.now() < end) {
      const now = await b.evaluate(() => { const f = document.querySelector('.assistant .as-feed'); return `${document.querySelector('.assistant .sea')?.className.replace(/.*st-/, '') || ''}|${f.children.length}|${f.lastElementChild?.textContent}|${f.scrollHeight - f.clientHeight - f.scrollTop < 2}`; });
      still = now === last && now.endsWith('|true') && !/^(routing|sending|starting)\|/.test(now) ? still + 1 : 0;
      last = now;
      await sleep(50);
    }
    is(`${W} ...and its feed has stopped moving before it is scrolled up`, true, still >= 6 || `still moving: ${last.slice(0, 60)}`);
  }
  await b.evaluate(() => { const f = document.querySelector('.assistant .as-feed'); f.scrollTop = 0; f.dispatchEvent(new Event('scroll')); });
  await sleep(300);
  await late;
  is(`${W} ...and scrolled to its top, its newest row is out of view`, true,
     (await seen('.assistant .as-feed', '.assistant .as-feed .as-row')) !== 'in view');
  const marked = await b.evaluate(() => { const m = [...document.querySelectorAll('.assistant .as-feed .as-row.me')]; m.forEach(x => { x.dataset.old = '1'; }); return m.length; });
  const asBefore = await page();
  await send(FILL);
  const fresh = await until(() => !![...document.querySelectorAll('.assistant .as-feed .as-row.me')].pop()?.matches(':not([data-old])'));
  is(`${W} the assistant: the message sent goes into its feed`, true, !!fresh && marked > 0);
  await sleep(400);
  is(`${W} the assistant: a message sent from the top of a full feed is in view`, 'in view', await seen('.assistant .as-feed', '.assistant .as-feed .as-row.me'));
  is(`${W} ...and it is the feed that scrolled, not the window or the frame`, asBefore, await page());
  await shot('assistant');
  await b.evaluate(() => document.querySelector('.assistant .as-head .x')?.click());
  await sleep(200);
}
