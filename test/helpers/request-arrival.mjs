// Shared by phone-check and the team demo: an arrival, not a fixture already on screen.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../lib/browser.mjs';

export async function requestArrivals({ b, is, go, app = 'phone', readonly = false, shots = '' }) {
  const until = async (fn, ...args) => {
    for (let i = 0; i < 80; i++) { if (await b.evaluate(fn, ...args)) return true; await sleep(100); }
    return false;
  };
  const rects = () => b.evaluate(() => ['.session > .tabs', '.session > .chat', '.session > .composer'].map(s => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? [r.x, r.y, r.width, r.height].map(x => Math.round(x * 100) / 100) : null;
  }));
  const count = () => b.evaluate(async a => a === 'phone'
    ? (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_answer').length
    : window.__answers.length, app);
  const click = async (sel) => {
    const p = await b.evaluate(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
    if (!p) return;
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
    await sleep(150);
  };
  const shot = async (w, state) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${app}-${w}-${readonly ? 'readonly-' : ''}${state}.png`), Buffer.from(data, 'base64'));
  };
  const install = () => {
      window.__arrive = null;
      window.__answers = [];
      if (window.__arrivalFetch) return;
      const real = window.fetch.bind(window); window.__arrivalFetch = true;
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/act') && opts?.body) {
          const v = JSON.parse(opts.body);
          if (v.tool === 'fleet_answer') window.__answers.push(v.args);
        }
        const r = await real(url, opts);
        if (u.includes('grid-acme-api.json') && window.__quota) {
          const j = await r.json();
          j.cards = j.cards.map(c => c.name === 'rate-limit' ? { ...c, status: 'limit', limit_at: 2000000000 } : c);
          return new Response(JSON.stringify(j), { status: r.status });
        }
        if (/pane.*(?:json|session=)/.test(u)) {
          const j = await r.json();
          window.__originalPrompt = j.prompt || window.__originalPrompt;
          return new Response(JSON.stringify({ ...j, prompt: window.__arrive }), { status: r.status });
        }
        return r;
      };
  };
  await b.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${install.toString()})()` });
  for (const w of [390, 320, 1280]) {
    await b.viewport(w, 844);
    await b.evaluate(install);
    // Start a new session view with the empty pane fixture already installed.
    await b.evaluate(() => { location.hash = '#/'; });
    await until(() => !document.querySelector('.session'));
    await go();
    await until(() => !!document.querySelector('.session .chat .msg'));
    // Let the pane poll observe the empty fixture, then settle fonts and layout.
    await sleep(2800);
    await b.evaluate(() => document.querySelector('.modal .x')?.click());
    await b.evaluate(() => document.fonts.ready.then(() => 0));
    const before = await rects();
    const sentAtStart = await count();
    const n = `${app} ${w}${readonly ? ' read-only' : ''}: request arrival`;
    is(`${n}: starts with the three measured surfaces`, true, before.every(Boolean));
    is(`${n}: starts with no pending request`, false, await b.evaluate(() => !!document.querySelector('.session .request-return, .session [role=dialog]')));
    await shot(w, 'before');
    await b.evaluate(() => { window.__arrive = { ...window.__originalPrompt, fingerprint: window.__originalPrompt.fingerprint }; });
    const opened = await until(() => !!document.querySelector('[role=dialog] .ask'));
    is(`${n}: opens a dialog`, true, opened);
    is(`${n}: tabs, chat and composer stay put`, before, await rects());
    await shot(w, 'open');
    if (!opened) { await b.evaluate(() => { window.__arrive = null; }); continue; }
    is(`${n}: phone sheet or centred desktop modal`, true, await b.evaluate(() => {
      const r = document.querySelector('[role=dialog]').getBoundingClientRect();
      return innerWidth <= 900 ? Math.abs(r.bottom - innerHeight) < 2 : Math.abs(r.x + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 2;
    }));
    await click('.modal .x');
    is(`${n}: X closes without answering`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
    is(`${n}: reserved button remains`, true, await b.evaluate(() => !!document.querySelector('.request-return')));
    is(`${n}: dismissal leaves the layout put`, before, await rects());
    await shot(w, 'closed');
    await sleep(2800);
    is(`${n}: the same poll does not reopen it`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
    const route = await b.evaluate(() => location.hash);
    await b.evaluate(() => { location.hash = '#/'; });
    await sleep(250);
    await b.evaluate(h => { location.hash = h; }, route);
    await until(() => !!document.querySelector('.request-return'));
    is(`${n}: returning to the session preserves dismissal`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
    await click('.request-return');
    is(`${n}: button reopens it`, true, await b.evaluate(() => !!document.querySelector('[role=dialog] .ask')));
    await b.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    is(`${n}: Esc dismisses it`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
    await click('.request-return');
    for (const type of ['mousePressed', 'mouseReleased']) await b.call('Input.dispatchMouseEvent', { type, x: 4, y: 4, button: 'left', clickCount: 1 });
    await sleep(100);
    is(`${n}: a press beside it dismisses it`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
    await b.evaluate(() => { window.__arrive = { ...window.__originalPrompt, fingerprint: 'next-request' }; });
    is(`${n}: a different request opens automatically`, true, await until(() => !!document.querySelector('[role=dialog] .ask')));
    await b.evaluate(() => { window.__arrive = null; });
    is(`${n}: a remote answer closes the open dialog`, true, await until(() => !document.querySelector('[role=dialog]') && !document.querySelector('.request-return')));
    await b.evaluate(() => { window.__arrive = window.__originalPrompt; });
    await until(() => !!document.querySelector('[role=dialog] .ask'));
    is(`${n}: dismissal never sends an answer`, sentAtStart, await count());
    if (readonly) {
      is(`${n}: choices cannot answer`, true, await b.evaluate(() => [...document.querySelectorAll('.ask .opt')].every(x => x.disabled)));
      await b.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51 });
      is(`${n}: a read-only number key sends nothing`, sentAtStart, await count());
    } else {
      const sentBefore = await count();
      if (w === 1280) await b.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51 });
      else await click('.ask .opt:last-child');
      await until(() => !document.querySelector('[role=dialog]'));
      is(`${n}: answer closes it`, false, await b.evaluate(() => !!document.querySelector('[role=dialog]')));
      is(`${n}: answer sent exactly once`, sentBefore + 1, await count());
      is(`${n}: the original answer payload is retained`, ['3', false, await b.evaluate(() => window.__originalPrompt.fingerprint)], await b.evaluate(async a => {
        const v = a === 'phone' ? (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_answer')[0]?.args : window.__answers.at(-1);
        return v && [v.text, v.no_enter, v.expect];
      }, app));
    }
    await b.evaluate(() => { window.__arrive = null; });
    await until(() => !document.querySelector('[role=dialog]') && !document.querySelector('.request-return'));
    is(`${n}: moving on removes the request`, false, await b.evaluate(() => !!document.querySelector('[role=dialog], .request-return')));
  }
  if (app !== 'phone') return;
  for (const w of [390, 1280]) {
    await b.viewport(w, 844);
    await sleep(200);
    const before = await rects();
    await b.evaluate(() => { window.__arrive = { kind: 'question', fingerprint: 'release-question', question: 'Which project should ship first?', typing: true }; });
    is(`${w}: an agent question opens a dialog`, true, await until(() => !!document.querySelector('.modal .ask.question')));
    is(`${w}: a question leaves the layout put`, before, await rects());
    await click('.ask input');
    await b.call('Input.insertText', { text: 'acme-api' });
    await click('.modal .x');
    await click('.request-return');
    is(`${w}: a dismissed question keeps the draft`, 'acme-api', await b.evaluate(() => document.querySelector('.ask input')?.value));
    await shot(w, 'question');
    is(`${w}: the question submit is usable`, true, await b.evaluate(() => { const b = document.querySelector('.ask button[type=submit]'), r = b?.getBoundingClientRect(); return !!b && !b.disabled && r.right <= innerWidth && r.bottom <= innerHeight || (b && { disabled: b.disabled, rect: r.toJSON() }); }));
    await click('.ask button[type=submit]');
    await until(() => !document.querySelector('[role=dialog]'));
    is(`${w}: the typed answer keeps its payload`, ['acme-api', false, 'release-question'], await b.evaluate(async () => {
      const a = (await import(location.origin + '/api.js')).auditLog().filter(r => r.tool === 'fleet_answer')[0]?.args;
      return a && [a.text, a.no_enter, a.expect];
    }));
    await b.evaluate(() => { window.__arrive = null; });
    await until(() => !document.querySelector('.request-return'));
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/rate-limit'; });
    await sleep(3300);
    const quotaBefore = await rects();
    await b.evaluate(() => { window.__quota = true; });
    is(`${w}: a quota notice opens a dialog`, true, await until(() => !!document.querySelector('.modal .ask.limit')));
    is(`${w}: a quota notice leaves the layout put`, quotaBefore, await rects());
    await click('.modal .x');
    is(`${w}: quota has a reserved way back`, true, await b.evaluate(() => !!document.querySelector('.request-return')));
    await click('.request-return');
    await b.evaluate(() => { window.__quota = false; });
    is(`${w}: the quota dialog closes when cleared`, true, await until(() => !document.querySelector('[role=dialog], .request-return')));
    await b.evaluate(() => { location.hash = '#/p/acme-api/s/api-fix'; });
    await sleep(2800);
  }
}
