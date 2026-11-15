// Real keyboard input through an arriving request, over the phone's fixture adapter.
import { sleep } from '../../lib/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

export async function requestTyping({ b, is, shots = '' }) {
  const shot = async (width, state) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `typing-${width}-${state}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await b.evaluate(fn)) return true; await sleep(25); }
    return false;
  };
  const answers = () => b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_answer').map(r => r.args));
  const key = async (k) => {
    const code = k === 'Enter' ? 'Enter' : k === ' ' ? 'Space' : /^\d$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`;
    const vk = k === 'Enter' ? 13 : k === ' ' ? 32 : k.toUpperCase().charCodeAt(0);
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : k });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const click = async (selector) => {
    const p = await b.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, selector);
    if (!p) return false;
    for (const type of ['mousePressed', 'mouseReleased']) await b.call('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(60); return true;
  };
  await b.evaluate(() => {
    if (window.__typingFetch) return;
    const real = window.fetch.bind(window); window.__typingFetch = true;
    window.__typingPrompt = null; window.__typingDelivered = '';
    window.fetch = async (u, o) => {
      const r = await real(u, o);
      if (String(u).includes('fixtures/jarvis.json') && window.__typingApprovals) {
        const j = await r.json();
        return new Response(JSON.stringify({ ...j, pending: (j.pending || []).map(p => ({ ...p, id: `typing-${p.id}` })) }), { status: r.status });
      }
      if (!String(u).includes('fixtures/pane-acme-api-api-fix.json')) return r;
      const j = await r.json(); window.__typingOriginal = j.prompt || window.__originalPrompt || window.__typingOriginal;
      window.__typingDelivered = window.__typingPrompt?.fingerprint || '';
      return new Response(JSON.stringify({ ...j, prompt: window.__typingPrompt }), { status: r.status });
    };
    new MutationObserver(() => {
      const box = document.querySelector('.session [role=dialog]');
      if (box && box !== window.__typingBox) { window.__typingBox = box; window.__typingOpenedAt = performance.now(); }
    }).observe(document.body, { childList: true, subtree: true });
    addEventListener('keydown', e => {
      if (e.target.matches?.('.composer textarea')) window.__typingLastKey = performance.now();
    }, true);
  });
  const clear = async () => {
    await b.evaluate(() => { window.__typingPrompt = null; });
    if (!await until(() => !document.querySelector('.session [role=dialog], .session .request-return'))) {
      throw new Error('fixture request did not clear: ' + JSON.stringify(await b.evaluate(() => ({
        delivered: window.__typingDelivered, hidden: document.hidden, hash: location.hash,
        modal: document.querySelector('[role=dialog]')?.textContent, width: innerWidth,
        active: document.activeElement?.outerHTML.slice(0, 200),
      }))));
    }
  };
  const fresh = async () => {
    await clear();
    await b.evaluate(() => { location.hash = '#/'; });
    await until(() => !document.querySelector('.session'));
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/api-fix'; });
    await until(() => !!document.querySelector('.session .chat .msg') && !!window.__typingOriginal && window.__typingDelivered === '' &&
      !document.querySelector('[role=dialog]') && getComputedStyle(document.querySelector('.composer textarea')).visibility === 'visible');
    await b.evaluate(() => { const n = document.querySelector('.composer textarea'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const arrive = (id) => b.evaluate(k => { window.__typingPrompt = { ...window.__typingOriginal, fingerprint: k }; }, id);
  const at = async (ms) => b.evaluate(delay => new Promise(ok => setTimeout(ok, Math.max(0, window.__typingOpenedAt + delay - performance.now()))), ms);
  for (const width of [390, 1280]) {
    await b.viewport(width, 844);
    await fresh();
    const n = `${width}: typed-through request keys`;
    const before = (await answers()).length;
    await arrive(`guard-${width}`);
    await until(() => !!document.querySelector('.session [role=dialog]'));
    await at(100); await key('2'); await sleep(80);
    const early = (await answers()).length;
    is(`${n}: 2 at 100 ms calls fleet_answer zero times`, before, early);
    await at(1000); await key('2'); await sleep(80);
    const late = await answers();
    is(`${n}: 2 after 1 s calls fleet_answer once`, early + 1, late.length);
    is(`${n}: the eligible digit sends 2`, '2', late[0]?.text);
    await clear();

    await fresh();
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    await shot(width, 'before');
    const text = 'fix the 2 failing tests';
    await key(text[0]);
    await arrive(`sentence-${width}`);
    for (const c of text.slice(1)) { await key(c); await sleep(140); }
    await until(() => window.__typingDelivered === `sentence-${innerWidth}`);
    is(`${width}: arrival keeps the composer focused mid-sentence`, true, await b.evaluate(() => document.activeElement === document.querySelector('.composer textarea')));
    is(`${width}: arrival keeps the complete sentence`, text, await b.evaluate(() => document.querySelector('.composer textarea').value));
    is(`${width}: a held request leaves the box visible`, true, await b.evaluate(() => getComputedStyle(document.querySelector('.composer textarea')).visibility === 'visible' && !document.querySelector('.session [role=dialog]')));
    await shot(width, 'held');
    const finishedAt = await b.evaluate(() => window.__typingLastKey);
    await until(() => !!document.querySelector('.session [role=dialog]'));
    is(`${width}: automatic opening waits for a 2 s typing pause`, true, await b.evaluate(t => window.__typingOpenedAt - t >= 1950, finishedAt));
    await shot(width, 'paused');
    await click('.session .ask .opt:last-child');
    await clear();
    is(`${width}: answering restores the draft in the visible box`, [true, text], await b.evaluate(() => { const n = document.querySelector('.composer textarea'); return [getComputedStyle(n).visibility === 'visible', n.value]; }));
    is(`${width}: drafts.js keeps the sentence`, text, await b.evaluate(() => JSON.parse(localStorage.getItem('gfw.drafts') || '{}')['acme-api\x1fapi-fix']?.text || ''));

    await fresh();
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    await key('f');
    await arrive(`enter-${width}`);
    for (let i = 0; i < 20; i++) {
      await key('f');
      if (await b.evaluate(() => window.__typingDelivered === `enter-${innerWidth}`)) break;
      await sleep(180);
    }
    const heldText = await b.evaluate(() => document.querySelector('.composer textarea').value);
    const sent = await b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_send').length);
    await key('Enter');
    is(`${width}: Enter opens a held request`, true, await until(() => !!document.querySelector('.session [role=dialog]'), 500));
    is(`${width}: Enter on a held request sends no draft`, sent, await b.evaluate(async () => (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_send').length));
    const count = (await answers()).length;
    await at(800); await key('2'); await sleep(50);
    is(`${width}: a digit within 1.5 s of composer typing sends nothing`, count, (await answers()).length);
    await click('.session .ask .opt:nth-child(2)');
    is(`${width}: clicking a choice bypasses the keyboard delay`, count + 1, (await answers()).length);
    await clear();
    is(`${width}: Enter and the answer retain the draft`, heldText, await b.evaluate(() => document.querySelector('.composer textarea').value));

    await fresh();
    await b.evaluate(() => document.querySelector('.composer textarea').focus());
    await key('f');
    await arrive(`blur-${width}`);
    for (let i = 0; i < 20; i++) {
      await key('f');
      if (await b.evaluate(() => window.__typingDelivered === `blur-${innerWidth}`)) break;
      await sleep(180);
    }
    const blurDraft = await b.evaluate(() => document.querySelector('.composer textarea').value);
    await b.evaluate(() => document.querySelector('.composer textarea').blur());
    is(`${width}: leaving the composer opens a held request without waiting`, true, await until(() => !!document.querySelector('.session [role=dialog]'), 500));
    await clear();
    is(`${width}: a request going away restores the visible draft`, [true, blurDraft], await b.evaluate(() => { const n = document.querySelector('.composer textarea'); return [getComputedStyle(n).visibility === 'visible', n.value]; }));
  }
  // A pending approval is the same request after a trip away from Home.
  await clear();
  // The broader phone check has answered the original proposal. Deliver a fresh fixture ID.
  await b.evaluate(() => { window.__typingApprovals = true; });
  await b.evaluate(() => { location.hash = '#/'; });
  await until(() => !!document.querySelector('.proposal-return'));
  if (!await b.evaluate(() => !!document.querySelector('.proposal-slot [role=dialog]'))) await click('.proposal-return');
  is('the assistant approval opens before dismissal', true, await until(() => !!document.querySelector('.proposal-slot [role=dialog]')));
  await click('.proposal-slot .modal .x');
  is('the assistant approval closes without answering', false, await b.evaluate(() => !!document.querySelector('.proposal-slot [role=dialog]')));
  await b.evaluate(() => { location.hash = '#/settings'; });
  is('navigation leaves the assistant approval screen', true, await until(() => document.querySelector('.page-head h1')?.textContent === 'Settings' && !document.querySelector('.proposal-slot')));
  await b.evaluate(() => { location.hash = '#/'; });
  await until(() => !!document.querySelector('.proposal-return'));
  await sleep(300);
  is('a dismissed assistant approval stays closed after leaving Home and returning', false, await b.evaluate(() => !!document.querySelector('.proposal-slot [role=dialog]')));
}
