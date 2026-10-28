#!/usr/bin/env node
// usage-check — the Claude accounts line at the top of Projects, and the sheet behind it,
// drawn by a real browser at a phone's size and at a desk's.
//
//     node test/helpers/usage-check.mjs <variants.json> [<shots dir>]   # "name <US> want <US> got" rows
//
// <variants.json> is { on, later, off, none }: payloads the suite made with fleet-serve's own
// usageReport() over test/helpers/usage-fixture.mjs, so what is drawn here is what the daemon
// would serve, not a hand-written guess at it. Three more are made from `on` by moving which
// account is active — onto one that is OUT, one that needs a login, one that is blocked — and
// nothing else: every state word in them is still the one describe() chose.
//   The payload reaches the page through its own fetch: the fixture backend asks for
// fixtures/usage.json, and a script installed before the app runs answers that one request
// with the variant named in the query string. Everything else is the shipped fixture fleet.
//   ONE BROWSER AT A TIME, phone then desktop: the suite's ceiling is four, and a check that
// held two would be spending half of it on itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, serveDir } from '../../lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

const [file, shots] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(file, 'utf8'));
const activeOn = (name) => {
  const v = JSON.parse(JSON.stringify(V.on));
  const work = v.profiles.find(p => p.profile === 'work');
  work.active = name; work.pin = null;
  for (const a of work.accounts) a.active = a.name === name;
  return v;
};
V['out-active'] = activeOn('spare');
V['login-active'] = activeOn('extra');
V['blocked-active'] = activeOn('old');
const acct = (v, prof, name) => v.profiles.find(p => p.profile === prof).accounts.find(a => a.name === name);

// The page's fetch, answering fixtures/usage.json from the variant in ?usage=.
const INJECT = `(() => {
  const V = ${JSON.stringify(V)};
  const v = new URLSearchParams(location.search).get('usage');
  if (!v || !(v in V)) return;
  const real = window.fetch.bind(window);
  window.__reads = { usage: 0, projects: 0, at: [] };
  window.fetch = (u, o) => {
    if (String(u).includes('fixtures/projects.json')) window.__reads.projects++;
    if (!String(u).includes('fixtures/usage.json')) return real(u, o);
    window.__reads.usage++; window.__reads.at.push(Date.now());
    return Promise.resolve(new Response(JSON.stringify(V[v]), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
})();`;

let b = null, srv = null;
try {
  srv = await serveDir(path.join(ROOT, 'web'));
  for (const [size, opts] of [['phone', { width: 390, height: 844, scale: 2, mobile: true }],
                              ['desktop', { width: 1280, height: 800, scale: 1, mobile: false }]]) {
    try { b = await launch(opts); }
    catch (e) {
      if (/no chrome/i.test(String(e && e.message))) { skipGroup('the accounts line', 'no chrome to draw it in'); done(0); }
      throw e;
    }
    await b.call('Page.enable', {});
    await b.call('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
    async function until(cond, ms = 15000) {
      const t0 = Date.now();
      let v = await cond();
      while (!v && Date.now() - t0 < ms) { await sleep(100); v = await cond(); }
      return v;
    }
    const open = async (variant) => {
      await b.call('Page.navigate', { url: `${srv.base}/index.html?usage=${variant}` });
      await sleep(600);
      await b.evaluate(() => { try { localStorage.clear(); } catch {} return null; });
      await b.call('Page.navigate', { url: `${srv.base}/index.html?usage=${variant}` });
      await until(() => b.evaluate(() => {
        const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
        if (e) e.click();
        return !!document.querySelector(':is(#app, #side) .card .c-top');
      }));
      return until(() => b.evaluate(() => !!document.querySelector(':is(#app, #side) .usage')), 8000);
    };
    // WHICHEVER PANE PROJECTS IS IN. On a phone that is #app; at 1280 with a mouse the client
    // draws two panes and Projects is the left one, #side (web/README.md, "On a desk").
    const line = () => b.evaluate(() => {
      const u = document.querySelector(':is(#app, #side) .usage');
      if (!u) return null;
      const r = u.getBoundingClientRect(), list = u.parentElement, first = list && list.firstElementChild;
      return {
        tag: u.tagName.toLowerCase(),
        lines: [...u.querySelectorAll('.u-line')].map(l => ({
          text: [...l.children].map(c => c.textContent.trim()).join(' | '),
          hue: (l.className.match(/\bu-(green|yellow|red|grey)\b/) || [])[1] || '',
          color: getComputedStyle(l.querySelector('.u-text')).color,
          // THE TEXT, not its row: the row hides what overflows, so a row can never be wider
          // than itself, and the first version of this measured it and passed over a line
          // whose last words were an ellipsis on the phone.
          cut: (t => t.scrollWidth > t.clientWidth + 1)(l.querySelector('.u-text')),
        })),
        first: first === u,
        inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        pageScrollsSideways: document.documentElement.scrollWidth > innerWidth,
        palette: Object.fromEntries(['--green', '--yellow', '--red', '--grey'].map(k => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])),
      };
    });
    const sheetText = () => b.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s ? s.textContent : ''; });
    const shot = async (name) => {
      if (!shots) return;
      const r = await b.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `${size}-${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const rgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`; };

    // ── on: one line per profile, each in its state's colour ─────────────────────────
    is(`${size}: the line is drawn at the top of Projects`, true, await open('on'));
    let l = await line();
    await shot('on');
    is(`${size}: ...first in the list, above the cards`, true, !!l && l.first);
    is(`${size}: ...and in view without scrolling`, true, !!l && l.inView);
    is(`${size}: one line per profile, each named, in the brief's shape`,
       ['work | main · 5h 37% (2h10m) · 7d 42% (Sat)', 'personal | all accounts exhausted until 17:00 — workers paused'],
       l && l.lines.map(x => x.text));
    is(`${size}: ...green for a fresh active account, red for a profile with every account out`, 'green,red', l && l.lines.map(x => x.hue).join(','));
    // THE PALETTE'S OWN COLOURS, read back off the drawn text: a new hue would pass the class row.
    is(`${size}: ...painted in the palette's green and red`, l ? [rgb(l.palette['--green']), rgb(l.palette['--red'])] : 'a line', l && l.lines.map(x => x.color));
    is(`${size}: no line is cut off, and the page does not scroll sideways`, 'false,false|false',
       l && `${l.lines.map(x => x.cut).join(',')}|${l.pageScrollsSideways}`);
    is(`${size}: ...it is a control`, 'button', l && l.tag);

    // ── GENTLY: once per 45s and on a focus, never once per Projects poll, never a burst ──
    // Counted at the page's fetch, beside the Projects reads that prove the poll was running —
    // a count of 1 from a page whose poll never ran would say nothing. Phone only: the clock
    // is the same code at any size, and each pass costs twenty seconds of waiting.
    if (size === 'phone') {
      const reads = () => b.evaluate(() => ({ ...window.__reads }));
      const r0 = await reads();
      await sleep(11000);
      const r1 = await reads();
      is('the accounts are read once while Projects polls on (usage reads, polls ≥ 2)', '1 true',
         `${r1.usage} ${r1.projects - r0.projects >= 2}`);
      await b.evaluate(() => { dispatchEvent(new Event('focus')); return null; });
      await sleep(6500);
      const r2 = await reads();
      is('...read again once the window takes focus back', 2, r2.usage);
      // A burst of focuses makes ONE read due, and not before 10s after the last: asked of the
      // reads' own times, so the row does not depend on where the 5s poll happens to fall.
      // Waited FOR, then given a further 6s in which a fourth read would be the burst: the third
      // is due 10s after the second plus up to one 5s poll, and a loaded runner took longer than
      // a fixed 12s to reach it.
      await b.evaluate(() => { for (let i = 0; i < 5; i++) dispatchEvent(new Event('focus')); return null; });
      await until(async () => (await reads()).usage >= 3, 25000);
      await sleep(6000);
      const r3 = await reads(), gaps = r3.at.slice(1).map((t, i) => t - r3.at[i]);
      is('...and five focuses in a row are one more read, at least 10s after the last', '3 true',
         `${r3.usage} ${gaps.every(g => g >= 10000)}${gaps.every(g => g >= 10000) ? '' : ' gaps ' + gaps.join(',')}`);
    }

    // ── the sheet: every account of every profile, in `fleet-accounts list`'s words ────
    await b.evaluate(() => { const u = document.querySelector(':is(#app, #side) .usage'); if (u) u.click(); return null; });
    const st = await until(sheetText, 4000);
    await shot('sheet');
    const want = ['switch at 97% of the 5h or 7d limit, spending the week that ends first',
      "on 'main' by hand until 15:47 — the planner leaves it there unless it runs out",
      'personal — ALL EXHAUSTED until 17:00, workers paused'];
    for (const p of V.on.profiles) for (const a of p.accounts) {
      want.push(a.state + (a.active && a.state !== 'active' ? ' (active)' : ''));
      for (const [k, lab] of [['five_hour', '5h'], ['seven_day', '7d']]) {
        const w = a[k];
        want.push(w ? `${lab} ${w.pct}% (resets ${w.resets_at}, read ${w.read})` : `${lab} —`);
      }
      if (a.fix) want.push(a.fix);
    }
    is(`${size}: the sheet says everything \`list\` says about each account, the pin and the threshold`, [],
       want.filter(t => !st.includes(t)));
    is(`${size}: ...for all seven accounts`, 7, await b.evaluate(() => document.querySelectorAll('#sheet .u-acct').length));
    is(`${size}: ...each in its state's colour`, 'green,yellow,red,red,red,red,red',
       await b.evaluate(() => [...document.querySelectorAll('#sheet .u-acct')].map(n => (n.className.match(/\bu-(green|yellow|red|grey)\b/) || [])[1]).join(',')));
    // Its buttons named in full, and its width asked of a sheet that is there: an absence
    // asserted with no sheet open is true of a client that never drew one.
    is(`${size}: ...and it offers no switch, only the way back`, ['esc back'],
       await b.evaluate(() => [...document.querySelectorAll('#sheet .sheet button')].map(n => n.textContent.trim())));
    is(`${size}: ...nor scrolls sideways`, false,
       await b.evaluate(() => { const s = document.querySelector('#sheet .sheet'); return s ? s.scrollWidth > s.clientWidth + 1 : 'no sheet'; }));

    // ── a reading older than six hours is said, in yellow ────────────────────────────
    await open('later');
    l = await line();
    const lw = acct(V.later, 'work', 'main');
    is(`${size}: a stale active account says how old its reading is, in yellow`,
       [`work | main · 5h ${lw.five_hour.pct}% (${lw.five_hour.left}) · 7d ${lw.seven_day.pct}% (${lw.seven_day.day}) · read ${lw.seven_day.read}`, 'yellow'],
       l && [l.lines[0].text, l.lines[0].hue]);

    // ── the active account cannot run: its state, in red ──────────────────────────────
    for (const [v, name] of [['out-active', 'spare'], ['login-active', 'extra'], ['blocked-active', 'old']]) {
      await open(v);
      l = await line();
      is(`${size}: active on '${name}': the line says ${acct(V.on, 'work', name).state.split(' ')[0]}, in red`,
         [`work | ${name} · ${acct(V.on, 'work', name).state}`, 'red'], l && [l.lines[0].text, l.lines[0].hue]);
    }

    // ── off: the sentence, and nothing else ──────────────────────────────────────────
    await open('off');
    l = await line();
    await shot('off');
    is(`${size}: with the experiment off, the line says so and nothing else`,
       [[V.off.off], 'grey'], l && [l.lines.map(x => x.text), l.lines.map(x => x.hue).join(',')]);
    is(`${size}: ...and is not a control`, 'div', l && l.tag);
    const tapped = await b.evaluate(() => { const u = document.querySelector(':is(#app, #side) .usage'); if (u) u.click(); return !!u; });
    await sleep(400);
    is(`${size}: ...so a tap on it opens nothing`, 'tapped|', `${tapped ? 'tapped' : 'no line'}|${await sheetText()}`);

    // ── on, with no profile holding an account ───────────────────────────────────────
    await open('none');
    l = await line();
    is(`${size}: on with no accounts yet, the line says that`, ['accounts: no profile has an account yet'], l && l.lines.map(x => x.text));

    await b.close(); b = null;
  }
} finally {
  if (b) await b.close().catch(() => {});
  if (srv) srv.close();
}
done(0);
