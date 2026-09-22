#!/usr/bin/env node
// grip-check — the card's TITLE is a tap target, and a drag from it still reorders.
//
//     node test/helpers/grip-check.mjs        # "name <US> want <US> got" rows
//
// THE BUG THIS EXISTS FOR. wire() (web/app.js) sets `dragging` on any press of the grip —
// the title row — and pointerup then computed how many rows the finger had travelled,
// found zero, and RETURNED. h.tap() never ran. Tap anywhere else on a card and it opens;
// tap the NAME and nothing happens at all.
//
// It hid for as long as a card was four identical monospace lines that nobody aimed at one
// of. The surface-card redesign made the name the biggest, boldest thing on the card, which
// turned the one dead target into the one a thumb goes for. It also blocked synthetic taps
// at the title, which is how it was found.
//
// WHY ITS OWN FILE AND NOT A SECTION OF viewport-check.mjs. It was written there first and
// took that helper from 1m45s to over twenty minutes — six cases each reloading the app
// interacted with the state the sections before it leave behind. Standalone it is ~40s,
// and it belongs apart anyway: viewport-check answers "does anything overflow", this
// answers "does a finger do what it looks like it will do".
//
// FOUR SHAPES, and the pair in the middle is the whole point. `steps === 0` is true BOTH
// for a finger that never left the grip AND for one that moved half a row and came back,
// because both end where they started. Only a flag set DURING the move separates them, and
// a drag the reader abandoned must not open the thing they were dragging.
//   The 8px case is deliberately INSIDE MOVE_SLOP (10px in app.js) — the same constant the
// rest of wire() already uses to decide a finger was still, rather than a second threshold
// invented here. At exactly 10px the test is `> MOVE_SLOP`, which is false, so 10 is still.
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
// The rows it already has survive a crash, for the reason test/helpers/pwa-render.mjs
// documents: a throw that discards every result reports the wreckage and not the cause.
process.on('uncaughtException', (e) => { console.log(rows.join('\n')); console.error(String(e && e.stack || e)); process.exit(1); });

let b = null, srv = null;
try {
  srv = await serveDir(path.join(ROOT, 'web'));
  try {
    b = await launch({ width: 390, height: 844, scale: 2, mobile: true });
  } catch (e) {
    // Skipped, not failed, where there is no Chrome — the suite's promise is no
    // dependencies, and this is one of the checks that cannot keep it.
    if (/no chrome/i.test(String(e && e.message))) { skipGroup('the card grip', 'no chrome to tap in'); done(0); }
    throw e;
  }
  const goto = async (u) => { await b.call('Page.navigate', { url: u }); await sleep(800); };
  const base = srv.base;

  // A CLEAN PROJECTS SCREEN PER CASE. Each gesture can navigate, so every case starts from
  // the same place rather than from wherever the last one left the app.
  const fresh = async () => {
    await goto(base + '/index.html');
    await b.evaluate(() => { try { localStorage.clear(); } catch {} return null; });
    await goto(base + '/index.html');
    await b.evaluate(() => {
      const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('continue without a passkey'));
      if (e) e.click(); return null;
    });
    await sleep(1000);
  };
  // ASKED AS THE END STATE, never as a transition. A poll for "did it change" can miss a
  // navigation that happened instantly and then wait forever for a change already made.
  const onGrid = () => b.evaluate(() => /:/.test((document.querySelector('#app > .hdr .scope') || {}).textContent || ''));
  const cardNames = () => b.evaluate(() => [...document.querySelectorAll('#app .card .c-name')].map(n => n.textContent.trim()));

  const gesture = (target, dy, back) => b.evaluate((t0, d, bk) => {
    const c = [...document.querySelectorAll('#app .card')][0];
    if (!c) return 'no card';
    const t = t0 === 'grip' ? c.querySelector('.c-top') : (c.querySelector('.c-msg') || c);
    if (!t) return 'no target';
    const r = t.getBoundingClientRect();
    const x = Math.round(r.left + 20), y = Math.round(r.top + 4);
    const pe = (n, X, Y, on) => on.dispatchEvent(new PointerEvent(n, { bubbles: true, clientX: X, clientY: Y, pointerId: 1 }));
    pe('pointerdown', x, y, t);
    if (d) pe('pointermove', x, y + d, t);
    const endY = bk ? y : y + d;
    if (bk) pe('pointermove', x, y, t);
    pe('pointerup', x, endY, c);
    return 'sent';
  }, target, dy, back);

  await fresh();
  is('there is a card with a title row to press', true,
     await b.evaluate(() => !!document.querySelector('#app .card .c-top')));

  for (const [what, tgt, dy, back, want] of [
    // THE ROW THIS FILE EXISTS FOR.
    ['a still press on the title opens the card',       'grip', 0,   false, true],
    // ...INSIDE the slop, so it is the same gesture as far as wire() is concerned.
    ['...and a wobble inside the slop still opens it',  'grip', 8,   true,  true],
    // ...and the two that a naive `steps === 0` check gets wrong.
    ['...but a real drag that returns opens nothing',   'grip', 40,  true,  false],
    ['...nor a longer one that returns',                'grip', 120, true,  false],
    // A drag that MOVES a row is a reorder and must not also open.
    ['...and a drag of a full row does not open it',    'grip', 110, false, false],
    // The rest of the card was never broken; it must stay unbroken.
    ['a press elsewhere on the card still opens it',    'body', 0,   false, true],
  ]) {
    await fresh();
    const sent = await gesture(tgt, dy, back);
    if (sent !== 'sent') { is(what, want, `gesture failed: ${sent}`); continue; }
    await sleep(1000);
    is(what, want, await onGrid());
  }

  // ...AND THE DRAG STILL REORDERS, which is what the grip is for and the thing a fix that
  // simply deleted the dragging branch would have destroyed. Against the ORDER, because
  // that is the observable: the reorder verb is refused in fixture mode, so what is
  // asserted is that the drag was RECOGNISED — the card lifts, and the drop indicator
  // names a direction.
  await fresh();
  const lifted = await b.evaluate(() => {
    const c = [...document.querySelectorAll('#app .card')][0];
    const t = c.querySelector('.c-top');
    const r = t.getBoundingClientRect();
    const x = Math.round(r.left + 20), y = Math.round(r.top + 4);
    const pe = (n, X, Y, on) => on.dispatchEvent(new PointerEvent(n, { bubbles: true, clientX: X, clientY: Y, pointerId: 1 }));
    pe('pointerdown', x, y, t);
    const onDown = c.classList.contains('lift');
    pe('pointermove', x, y + 110, t);
    const dir = c.classList.contains('drop-below') ? 'below' : c.classList.contains('drop-above') ? 'above' : 'none';
    pe('pointerup', x, y + 110, c);
    const cleared = !c.classList.contains('lift') && !c.classList.contains('drop-below');
    return { onDown, dir, cleared };
  });
  is('a drag from the title lifts the card', true, lifted.onDown);
  is('...and shows which way it will drop', 'below', lifted.dir);
  is('...and clears both on release', true, lifted.cleared);
} catch (e) {
  is('grip-check ran', 'yes', `no: ${String((e && e.message) || e)}`);
} finally {
  if (b) { try { await b.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
}
done(0);
