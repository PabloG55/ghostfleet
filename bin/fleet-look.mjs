#!/usr/bin/env node
// fleet-look — photograph the thing you just built, so you can look at it yourself.
//
//     fleet-look <url | file.html | file.pdf | file.png> [options]
//
// WHY THIS EXISTS. Measured over a corpus of real work: of 172 build turns that changed
// a screen file, 154 ran a test, lint or build and FOUR ever opened a browser — on
// exactly the surfaces whose defects came back as photographs. And the sessions where a
// human was the renderer are the sessions that iterated: 12 delivering sessions with no
// screenshot turn at all took 17 corrections across 76 turns, while 7 with fifteen or
// more took 215 across 671.
//
// The standing contract already tells every fleet session to say what it OBSERVED rather
// than what it ran. That instruction is worth nothing without a way to observe, and an
// instruction without a mechanism is the shape that has already failed here — the corpus
// holds an agent's own "Nobody has opened the UI. I've said this four times and it's
// still true". So: a command, not a paragraph.
//
// It prints a PATH. Claude Code's Read tool renders a PNG visually, so reading that path
// is the agent actually looking at its own work.
//
// WHAT IT REFUSES TO DO QUIETLY. A 404 renders as a page and photographs as a PNG, and a
// page whose script threw still paints. Either would let "I looked at it" mean nothing,
// which is this repo's dominant failure class arriving through the camera. So the status
// line and the title are printed BESIDE the path, always, and a page that could not be
// reached is an error rather than a photograph of an error page.
//
// A PICTURE IS NOT THE BEST CHANNEL. IT IS ONE OF THREE, AND THE WEAKEST ALONE.
// Measured by Macklon & Bezemer (EMSE 2026, arXiv 2501.09236) on real visual defects, a
// VLM asked whether a screen looks right recalls: state 33%, rendering 30%, LAYOUT 20%,
// appearance 14%. Four out of five layout bugs missed — and a clipped send button is a
// layout bug. What lifted median precision from 34-50% to 100% in that same study was not
// a better model, it was a bug-free REFERENCE image to compare against. Separately, the
// agentic web-testing work has moved to grounding on the ACCESSIBILITY TREE rather than
// raw pixels, because structure is a stronger and more stable signal than colour.
//
// So this command offers the channels that suit each question, and says which:
//   --tree   the accessibility tree — what is actually there, labelled, in reading order.
//            The right channel for "is the control present, named, and reachable", which
//            is what most "you forgot the UI" corrections turn out to be.
//   (image)  pixels, for what only pixels show: real fonts, real colour, real clipping,
//            and a PDF, where there is no DOM at all and the pixels ARE the artifact.
// Geometry — does it overflow, is it clipped — is better asked of the layout engine than
// of either, and test/helpers/viewport-check.mjs already asks it that way.
//
//   --width N     viewport width  (default 1280)
//   --height N    viewport height (default 800)
//   --full        capture the whole page, not just the viewport
//   --wait MS     settle after navigation (default 900)
//   --page N      which page of a PDF (default 1; needs pdftoppm for N > 1)
//   --tree        also print the accessibility tree (structure, not pixels)
//   --golden P    compare against the reference at P instead of just printing a shot
//   --update      write/refresh that reference rather than comparing (say so loudly)
//   --max-diff R  fraction of pixels allowed to differ (default 0.005)
//
// THE COMPARISON IS THE BEST-EVIDENCED PART, AND THE EASIEST TO GET KILLED.
// A bug-free reference lifted median precision from 34-50% to 100% in the study above,
// against 20% recall for open-ended looking — so comparing beats judging by a wide margin.
// But golden images drift on antialiasing, font rendering and browser versions, and a
// check that goes red for reasons nobody can read gets deleted. #44 is that story already.
// Three guards, all of them here rather than in a doc:
//   - the verdict is a FRACTION of differing pixels against a threshold, never equality
//   - on failure the expected, actual AND diff images are written next to each other and
//     their paths printed, so the reason is a picture rather than a number
//   - the Chrome build is printed on every comparison, because a golden captured on
//     another version is a stale baseline and must not read as a regression
//
// AND THE DIFF RUNS INSIDE THE BROWSER. node has no PNG decoder and this package has no
// dependencies; the browser already open for the screenshot has a canvas, so both images
// are drawn into one and compared with getImageData. No decoder, no library, no dep.
//   --out PATH    where to write the PNG (default: a temp file, path printed)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, serveDir, sleep } from '../lib/browser.mjs';

const argv = process.argv.slice(2);
const die = (m) => { console.error('fleet-look: ' + m); process.exit(1); };
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  console.log('usage: fleet-look <url | file.html | file.pdf | file.png> [--width N] [--height N] [--full] [--wait MS] [--page N] [--tree] [--out PATH]');
  process.exit(argv.length ? 0 : 1);
}
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
const target = argv[0];
const WIDTH = Number(opt('width', 1280)), HEIGHT = Number(opt('height', 800));
const WAIT = Number(opt('wait', 900)), PAGE = Number(opt('page', 1));
const GOLDEN = opt('golden', ''), MAXDIFF = Number(opt('max-diff', 0.005));
const OUT = opt('out', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-look-')), 'shot.png'));

const report = (rows, outPath) => {
  for (const [k, v] of rows) console.log(k.padEnd(14) + v);
  const st = fs.statSync(outPath);
  const buf = fs.readFileSync(outPath);
  const dims = buf.slice(1, 4).toString() === 'PNG'
    ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : 'unknown';
  console.log('image'.padEnd(14) + outPath);
  console.log('size'.padEnd(14) + `${dims}, ${Math.round(st.size / 1024)} KB`);
  console.log('\nRead that path to see it.');
};

// ── an image needs no rendering; say so rather than pretending to work ─────
if (/\.(png|jpe?g|gif|webp)$/i.test(target)) {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) die(`no such file: ${p}`);
  report([['looked at', p], ['rendered by', 'nothing — it is already an image']], p);
  process.exit(0);
}

// ── a PDF: the deployment renderer, not a browser's guess at one ───────────
// qlmanage is the system's own PDF renderer and ships on every mac; pdftoppm is the
// portable one and is the only route to a page other than the first. macOS-only calls
// need a guard here as everywhere else, so Linux without pdftoppm says so and stops
// rather than producing nothing and exiting 0.
if (/\.pdf$/i.test(target)) {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) die(`no such file: ${p}`);
  const which = (b) => { try { return String(execFileSync('/bin/sh', ['-c', `command -v ${b}`])).trim(); } catch { return ''; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-look-pdf-'));
  let renderer = '';
  if (PAGE > 1 || !which('qlmanage')) {
    if (!which('pdftoppm')) die(`cannot render a PDF here: qlmanage is macOS-only and pdftoppm is not installed${PAGE > 1 ? ' (and page ' + PAGE + ' needs pdftoppm)' : ''}`);
    execFileSync('pdftoppm', ['-png', '-r', '150', '-f', String(PAGE), '-l', String(PAGE), p, path.join(dir, 'p')]);
    renderer = 'pdftoppm (page ' + PAGE + ')';
  } else {
    execFileSync('qlmanage', ['-t', '-s', String(WIDTH), '-o', dir, p], { stdio: 'ignore' });
    renderer = 'qlmanage (page 1)';
  }
  const made = fs.readdirSync(dir).filter(f => /\.png$/i.test(f));
  if (!made.length) die(`the renderer produced no image for ${p} — it may not be a readable PDF`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(dir, made[0]), OUT);
  fs.rmSync(dir, { recursive: true, force: true });
  report([['looked at', p], ['rendered by', renderer]], OUT);
  process.exit(0);
}

// ── a page: a real engine, and the status printed beside the picture ───────
const isUrl = /^https?:\/\//i.test(target);
let url = target, srv = null;
if (!isUrl) {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) die(`no such file: ${p}`);
  srv = await serveDir(path.dirname(p), path.basename(p));
  url = `${srv.base}/${path.basename(p)}`;
}

let b;
try { b = await launch({ width: WIDTH, height: HEIGHT }); }
catch (e) { if (srv) srv.close(); die(String((e && e.message) || e)); }

const b_ = b;
const chromeBuild = (b.chromePath || '').split('/').pop() || 'chrome';
let status = null, failed = null;
try {
  await b.call('Page.navigate', { url });
  await sleep(WAIT);
  // Read the status back from the page rather than from an event stream: one extra
  // request, and it cannot miss a response that arrived before a listener attached.
  const probe = await b.evaluate(async (u) => {
    try { const r = await fetch(u, { method: 'GET', cache: 'no-store' }); return { ok: r.ok, status: r.status }; }
    catch (e) { return { ok: false, status: 0, err: String(e) }; }
  }, url);
  status = probe && probe.status;
  const info = await b.evaluate(() => ({
    title: document.title || '(no title)',
    text: (document.body ? document.body.innerText : '').trim().slice(0, 80).replace(/\s+/g, ' '),
    scrollH: document.documentElement.scrollHeight,
  }));
  if (status === 0 || status >= 400) failed = `HTTP ${status}`;
  if (flag('full') && info.scrollH > HEIGHT) {
    await b.viewport(WIDTH, Math.min(info.scrollH, 8000));
    await sleep(200);
  }
  const { data } = await b.call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
  // A page that could not be reached must not be handed back as a photograph. The image
  // of a 404 is a perfectly good image, and that is exactly the problem.
  if (failed) die(`${url} answered ${failed} — a photograph of an error page is not an observation. Image left at ${OUT}`);
  // The tree BEFORE the image, because it answers a different question and answers it
  // better: "is the control there, named, and reachable" is structure, and a VLM reading
  // pixels for that recalls one layout bug in five.
  if (flag('tree')) {
    const { nodes } = await b.call('Accessibility.getFullAXTree', {});
    const seen = [];
    for (const n of nodes || []) {
      const role = n.role && n.role.value, name = n.name && n.name.value;
      if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox') continue;
      if (!name && !['textbox', 'checkbox', 'image', 'button'].includes(role)) continue;
      seen.push(`  ${role}${name ? ': ' + String(name).replace(/\s+/g, ' ').slice(0, 60) : ' (unnamed)'}`);
      if (seen.length >= 60) break;
    }
    console.log('accessibility tree (' + seen.length + (seen.length >= 60 ? '+' : '') + ' named nodes)');
    console.log(seen.join('\n') || '  (nothing named — that is itself the finding)');
    console.log('');
  }
  // ── the comparison, when a reference was named ───────────────────────────
  if (GOLDEN) {
    const gp = path.resolve(GOLDEN);
    if (flag('update') || !fs.existsSync(gp)) {
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.copyFileSync(OUT, gp);
      // Loudly: a run that silently WRITES a baseline is a run that can never fail, and
      // the first one is the one most likely to bake in a bug as the expectation.
      console.log(flag('update') ? 'BASELINE UPDATED — nothing was compared this run'
                                 : 'BASELINE CREATED — nothing was compared this run');
      console.log('reference     ' + gp);
      report([['looked at', url], ['chrome', chromeBuild]], OUT);
      process.exit(0);
    }
    const a = 'data:image/png;base64,' + fs.readFileSync(gp).toString('base64');
    const b = 'data:image/png;base64,' + fs.readFileSync(OUT).toString('base64');
    const d = await b_.evaluate(async (aSrc, bSrc) => {
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const [ia, ib] = await Promise.all([load(aSrc), load(bSrc)]);
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      const c = (im) => { const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        const x = cv.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, cv.width, cv.height); };
      const A = c(ia), B = c(ib);
      const out = document.createElement('canvas'); out.width = ia.width; out.height = ia.height;
      const ox = out.getContext('2d'); const D = ox.createImageData(ia.width, ia.height);
      let diff = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        // Per-channel tolerance: subpixel antialiasing moves a channel by a few units on
        // a font the eye cannot tell apart, and counting those is how a suite goes red
        // for a reason nobody can read.
        const dr = Math.abs(A.data[i] - B.data[i]), dg = Math.abs(A.data[i+1] - B.data[i+1]), db = Math.abs(A.data[i+2] - B.data[i+2]);
        const off = dr > 12 || dg > 12 || db > 12;
        if (off) { diff++; D.data[i] = 255; D.data[i+1] = 0; D.data[i+2] = 0; D.data[i+3] = 255; }
        else { const g = (A.data[i] + A.data[i+1] + A.data[i+2]) / 3;
               D.data[i] = D.data[i+1] = D.data[i+2] = 220 - g * 0.35 | 0; D.data[i+3] = 255; }
      }
      ox.putImageData(D, 0, 0);
      return { total: A.data.length / 4, diff, ratio: diff / (A.data.length / 4), png: out.toDataURL('image/png') };
    }, a, b);
    if (d && d.sizeMismatch) die(`the reference is a different size: ${d.sizeMismatch} — a golden captured at another viewport is a stale baseline, not a regression. Re-take it with --update if that is what you meant.`);
    const pct = (d.ratio * 100).toFixed(3);
    if (d.ratio > MAXDIFF) {
      // THE PAIR ON RED. A number nobody can picture is what gets a golden deleted.
      const dir = path.dirname(OUT);
      const dp = path.join(dir, 'diff.png'), ep = path.join(dir, 'expected.png');
      fs.writeFileSync(dp, Buffer.from(String(d.png).split(',')[1], 'base64'));
      fs.copyFileSync(gp, ep);
      console.error(`fleet-look: ${pct}% of pixels differ (allowed ${(MAXDIFF*100).toFixed(3)}%) — ${d.diff} of ${d.total}`);
      console.error('  expected  ' + ep);
      console.error('  actual    ' + OUT);
      console.error('  diff      ' + dp + '   (differences in red)');
      console.error('  chrome    ' + chromeBuild + '   — a reference taken on another build is a stale baseline, not a regression');
      process.exit(1);
    }
    console.log(`matches the reference   ${pct}% of pixels differ, allowed ${(MAXDIFF*100).toFixed(3)}%`);
    console.log('reference     ' + gp);
    report([['looked at', url], ['chrome', chromeBuild]], OUT);
    process.exit(0);
  }
  report([['looked at', url],
          ['http status', String(status)],
          ['title', info.title],
          ['first text', info.text || '(the page rendered no text)'],
          ['viewport', `${WIDTH}x${HEIGHT}${flag('full') ? ' (full page)' : ''}`]], OUT);
} finally {
  try { b && b.close(); } catch {}
  try { srv && srv.close(); } catch {}
}
