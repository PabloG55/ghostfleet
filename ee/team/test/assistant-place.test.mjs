// One assistant, one place per screen. The home page's card ("What are we doing today?") and the
// floating Assistant button are one assistant: one conversation, one voice, the same options
// (agent.js). On the home page both were on screen, and they read as two assistants. Away from it,
// a request in flight showed in a bar of its own in the middle of the page, with its own Open,
// beside the button that also opened it: two again. Now the card is the assistant on the home
// page and the button is not there; everywhere else the button is, it opens the same
// conversation, and it says what the assistant is doing. The card has the panel's controls, and
// the panel is not a page: opening and closing it leaves the history as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { sleep } from '../../../lib/browser.mjs';

const AWAY = [['#/map', '.ocean'], ['#/p/acme-web', '.main h1'], ['#/p/acme-web/s/onboarding', '.sess-head'],
  ['#/automations', '.main h1'], ['#/activity', '.main h1'], ['#/settings', '.main h1'], ['#/admin', '.main h1']];
const ROUTING = 'Working out where it goes…';          // ship.routing, the state a held /api/route keeps

for (const [size, width, height] of [['desk', 1440, 900], ['phone', 390, 844]]) {
  test(`${size} ${width}×${height}: the card is the assistant at home, the button everywhere else, one conversation in both`, { timeout: 300000 }, async (t) => {
    const { b, click, press, until, go } = await browse(t, { width, height });
    const problems = [];
    const want = (ok, msg) => { if (!ok) problems.push(`${size}: ${msg}`); return ok; };
    const q = (s) => b.evaluate((sel) => !!document.querySelector(sel), s);
    const text = (s) => b.evaluate((sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null, s);
    // true once `fn` holds, false if it has not in `ms`: a check that fails is a row, not a timeout
    const soon = async (fn, ms = 5000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); } return false; };
    const has = (s, words) => soon(async () => ((await text(s)) || '').includes(words));
    // same-document, as a link does: a reload would start a new conversation and prove nothing
    const hash = async (h, ready) => {
      await b.evaluate((x) => { location.hash = x; }, h);
      return want(await soon(() => b.evaluate((x, s) => location.hash === x && !!document.querySelector(s), h, ready)), `${h} never showed ${ready}`);
    };
    const say = async (box, words) => { await click(`${box} form input`); await b.call('Input.insertText', { text: words }); await sleep(100); await press('Enter'); };
    const choose = async (box, label) => {
      if (!want(await q(`${box} .select`), `${box} has no "Talking to" picker`)) return;
      await click(`${box} .select`);
      const ok = await soon(() => b.evaluate((l) => {
        document.querySelectorAll('#t-pick').forEach(x => x.removeAttribute('id'));
        const o = [...document.querySelectorAll('.select-list [role=option]')].find(e => e.textContent.trim() === l);
        if (o) o.id = 't-pick';
        return !!o;
      }, label));
      if (want(ok, `${box}'s picker has no "${label}"`)) await click('#t-pick'); else await press('Escape');
    };
    const pick = (box) => text(`${box} .select .select-v`);
    // A phone's Requests rail covers the page; it is not what this is about
    const unrail = async () => { if (size === 'phone' && await q('.rail')) await click('.rail-head .x'); };
    const shut = async () => { if (await q('.assistant')) { await click('.assistant .as-head .x'); await soon(async () => !(await q('.assistant'))); } };
    const nav = () => b.call('Page.getNavigationHistory', {});

    // Home: the card, its controls, and nothing floating that opens a second one
    await go('/', '.home-agent');
    await sleep(800);
    want(!(await q('.as-launch')), 'the floating Assistant button is on the home page, beside the card');
    want(!(await q('.voicebar')), 'a voice bar is on the home page');
    want(await q('.home-agent .talk-to [role=combobox]'), 'the card has no "Talking to" picker');
    if (await q('.home-agent .talk-to')) want((await pick('.home-agent .talk-to')) === 'Auto', `the card talks to ${await pick('.home-agent .talk-to')}, not Auto`);
    want(await q('.home-agent .voice-opts-btn'), 'the card has no Voice options');

    // Every other screen has the button
    for (const [h, ready] of AWAY) if (await hash(h, ready)) want(await soon(() => q('.as-launch')), `${h} has no floating Assistant button`);

    // Said on the card, read in the panel on another screen
    await hash('#/', '.home-agent');
    const one = 'check the payment tests, from the card';
    await say('.home-agent', one);
    want(await has('.home-agent .as-feed', one), 'the card did not show what was typed on it');
    await unrail();
    await hash('#/map', '.ocean');
    await click('.as-launch');
    if (want(await soon(() => q('.assistant')), 'the button on the map opened no panel'))
      want(await has('.assistant .as-feed', one), 'the panel on the map does not have what was said on the card');

    // ...and the reverse, which also goes home with the panel open: only the card is left
    const two = 'open the invoice tests, from the panel';
    if (await q('.assistant')) {
      await say('.assistant', two);
      want(await has('.assistant .as-feed', two), 'the panel did not show what was typed in it');
    }
    await unrail();
    await hash('#/', '.home-agent');
    await sleep(600);
    want(!(await q('.assistant')), 'going home with the panel open left the panel open beside the card');
    want(!(await q('.as-launch')), 'going home left a floating button beside the card');
    want(await has('.home-agent .as-feed', two), 'the card at home does not have what was said in the panel');
    await shut();

    // A reload on the home page does not bring the panel back beside the card
    await b.evaluate(() => localStorage.setItem('gfw.asOpen', '1'));
    await b.call('Page.reload', {});
    await soon(() => q('.home-agent'), 15000);
    await sleep(800);
    want(!(await q('.assistant')), 'a reload on the home page opened the panel beside the card');
    await shut();

    // Same controls: a lead chosen on the card is the panel's, and it is what the router is told
    await choose('.home-agent .talk-to', 'acme-web lead');
    if (await q('.home-agent .talk-to')) want((await pick('.home-agent .talk-to')) === 'acme-web lead', `the card's picker reads ${await pick('.home-agent .talk-to')} after choosing acme-web lead`);

    // Busy: a request held at the router keeps the assistant at "working out where it goes"
    const held = [];
    await b.call('Fetch.enable', { patterns: [{ urlPattern: '*/api/route*' }] });
    const off = b.onEvent((m, p) => { if (m === 'Fetch.requestPaused') held.push(p); });
    try {
      await say('.home-agent', 'look at the failing build');
      if (want(await soon(async () => held.length > 0), 'nothing reached the router')) {
        const page = JSON.parse(held[0].request.postData || '{}').page || {};
        want(page.project === 'acme-web', `the router was told the page is ${JSON.stringify(page.project)}, not the chosen acme-web`);
      }
      want(await has('.home-agent .home-say', ROUTING), `the card says ${JSON.stringify(await text('.home-agent .home-say'))} while routing`);
      want(!(await q('.as-launch')) && !(await q('.voicebar')), 'at home a second place shows the assistant at work');
      want(await q('.home-agent .stop-all, .vb-stop'), 'there is no Stop on screen at home while a request is in flight');
      await unrail();
      await hash('#/map', '.ocean');
      want(await has('.as-launch', ROUTING), `away from home the button reads ${JSON.stringify(await text('.as-launch'))}, not ${JSON.stringify(ROUTING)}`);
      const named = await b.evaluate(() => document.querySelector('.as-launch')?.getAttribute('aria-label') || '');
      want(named.includes(ROUTING), `the button is named ${JSON.stringify(named)} while routing`);
      want(!(await q('.voicebar')), 'a bar of its own shows the state as well as the button');
      want(await q('.vb-stop'), 'there is no Stop on screen while a request is in flight');
    } finally {
      off();
      for (const p of held) await b.call('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      await b.call('Fetch.disable', {});
    }
    want(await soon(async () => !((await text('.as-launch')) || '').includes(ROUTING)), 'the button still says it is routing after the router answered');

    // The panel on the map has the lead chosen on the card, and Voice options; Auto chosen
    // there is the card's at home
    await unrail();
    await click('.as-launch');
    if (want(await soon(() => q('.assistant')), 'the button opened no panel')) {
      want((await pick('.assistant .as-target')) === 'acme-web lead', `the panel talks to ${JSON.stringify(await pick('.assistant .as-target'))}, not the acme-web lead chosen on the card`);
      want(await q('.assistant .voice-opts-btn'), 'the panel has no Voice options');
      await choose('.assistant .as-target', 'Auto');
    }
    await shut();
    await hash('#/', '.home-agent');
    if (await q('.home-agent .talk-to')) want((await pick('.home-agent .talk-to')) === 'Auto', `the card talks to ${JSON.stringify(await pick('.home-agent .talk-to'))} after Auto was chosen in the panel`);

    // The panel is not a page: back after opening and closing it is the screen before
    await hash('#/automations', '.main h1');
    await hash('#/map', '.ocean');
    await unrail();
    const was = await nav();
    await click('.as-launch');
    await soon(() => q('.assistant'));
    await shut();
    const now = await nav();
    want(now.entries.length === was.entries.length && now.currentIndex === was.currentIndex,
      `opening and closing the panel moved the history from ${was.currentIndex}/${was.entries.length} to ${now.currentIndex}/${now.entries.length}`);
    await b.evaluate(() => history.back());
    want(await soon(() => b.evaluate(() => location.hash === '#/automations')), `the browser's back went to ${await b.evaluate(() => location.hash)}, not the automations it came from`);
    // and the app's own back, from a session opened from the map
    await hash('#/map', '.ocean');
    await hash('#/p/acme-web/s/onboarding', '.sess-head .back-link');
    await click('.as-launch');
    await soon(() => q('.assistant'));
    await shut();
    await click('.sess-head .back-link');
    want(await soon(() => b.evaluate(() => location.hash === '#/map')), `the session's back went to ${await b.evaluate(() => location.hash)}, not the map it was opened from`);

    assert.deepEqual(problems, []);
  });
}
