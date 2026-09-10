#!/usr/bin/env node
// fleet-shots — walk a flow, photograph every step, and record what it ASKED FOR.
//
//     fleet-shots --flow <file.json> [--out DIR] [--base URL] [--dry-run]
//     fleet-shots <url> [<url> ...]              one step per url, no flow file
//
// WHY THIS EXISTS, and it is not the same reason as fleet-look's. fleet-look answers "does
// this one screen look right" and it answers it for the AGENT, by printing a path the agent
// reads. This answers a different question — "did the FLOW do the right thing" — and it
// answers it for a HUMAN, asynchronously, without them starting the dev stack and clicking
// through it themselves. The evidence for wanting it is direct: a reviewer who did exactly
// this by hand, a folder of screenshots opened in a browser, found mistakes that had
// already been committed.
//
// A SCREENSHOT ALONE IS NOT EVIDENCE, WHICH IS THE HALF THAT MAKES THIS WORTH BUILDING. A
// picture of a green success toast proves a toast rendered. It cannot tell you the mutation
// went to the right endpoint, went once, or went at all — and "looks right, talks to the
// wrong thing" is the defect a human reviewer is worst at catching by eye and a request log
// catches for free. So every step carries the requests it made, with method, status and
// URL, and the review page shows them beside the picture.
//
// PROVENANCE, FOR THE REASON THIS REPO KEEPS RE-LEARNING: a capture with no context is an
// assertion wearing a photograph. `a test can pass because of where it ran` applies exactly
// as much to a picture, so the manifest and the page header carry the commit, whether the
// tree was dirty, the base URL, the viewport and the time. And the URL shown for a step is
// the one the page ENDED UP ON, read back after navigation, never the one that was asked
// for — a redirect to a login screen photographs perfectly well.
//
// WHAT IT WRITES is a folder you can open with no server at all:
//
//     <out>/index.html      the review page, self-contained, works over file://
//     <out>/manifest.json   the same data, for anything that wants to read it
//     <out>/01-<step>.png   one per step
//
// The page is a review surface, not a gallery: every step gets ok / problem / skip and a
// note, and one button copies the verdict as text to paste back to whoever did the work.
// Deliberately NOT a server in this version. The workflow that already proved itself was a
// folder opened in a browser, a server is a process to leak (this repo has paid for that
// twice this week), and file:// cannot POST anywhere anyway. The manifest is there so a
// later `fleet-serve` route can render the same data without this command changing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../lib/browser.mjs';

const ARGV = process.argv.slice(2);
const die = (m) => { console.error('fleet-shots: ' + m); process.exit(1); };
const flag = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 ? (ARGV[i + 1] ?? d) : d; };
const has = (n) => ARGV.includes(n);

if (has('-h') || has('--help')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, 6).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// ── the flow ─────────────────────────────────────────────────────────────────
// A file, or bare URLs. The bare form exists because the commonest case is "photograph
// these three screens" and making that require a JSON file would mean it does not get used.
let flow;
const flowFile = flag('--flow');
if (flowFile) {
  let raw;
  try { raw = fs.readFileSync(flowFile, 'utf8'); } catch (e) { die(`cannot read ${flowFile}: ${e.message}`); }
  try { flow = JSON.parse(raw); } catch (e) { die(`${flowFile} is not JSON: ${e.message}`); }
  if (!Array.isArray(flow.steps) || !flow.steps.length) die(`${flowFile} has no "steps" array`);
} else {
  const urls = ARGV.filter(a => /^https?:\/\//.test(a));
  if (!urls.length) die('nothing to photograph — pass --flow <file.json> or one or more URLs (--help)');
  flow = { steps: urls.map(u => ({ name: u.replace(/^https?:\/\//, ''), goto: u })) };
}
const BASE = flag('--base', flow.base || '');
const VW = Number(flag('--width', flow.viewport?.width || 1280));
const VH = Number(flag('--height', flow.viewport?.height || 800));

// ── where it lands ───────────────────────────────────────────────────────────
// Under the fleet dir by default rather than a temp dir: this is a thing a human opens
// later, possibly from another machine over a synced folder, and a path that gets swept
// on reboot is a review that vanishes before it is read.
//   19, not 17: the ISO string is `2026-09-10T05:00:12.345Z`, and cutting at 17 lands
// mid-token and leaves a folder called `..._05-00-` — a name that reads as a truncation
// bug every time anyone looks at the directory.
const OUT = path.resolve(flag('--out') || path.join(
  process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude', 'fleet'),
  'shots', new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)));

// ── provenance ───────────────────────────────────────────────────────────────
// Read, not assumed, and each field allowed to be unknown: this runs in a worktree, in a
// checkout with no commits, and on a machine with no git. An absent field must read as
// absent rather than as a confident wrong value.
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const prov = {
  commit: git('rev-parse', 'HEAD') || null,
  branch: git('rev-parse', '--abbrev-ref', 'HEAD') || null,
  dirty: git('status', '--porcelain') !== '' || null,
  repo: git('rev-parse', '--show-toplevel') || null,
  base: BASE || null,
  viewport: { width: VW, height: VH },
  at: new Date().toISOString(),
  session: process.env.CLAUDE_FLEET_SLOT || null,
  slot: process.env.CLAUDE_FLEET_SLOT_PORT || null,
};

const slug = (s, i) => `${String(i + 1).padStart(2, '0')}-` +
  (String(s || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step');
const abs = (u) => (/^https?:\/\//.test(u) ? u : (BASE ? BASE.replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u) : u));

// A DRY RUN, SO THE ARGUMENT SURFACE IS TESTABLE WITHOUT A BROWSER. Everything above this
// line is parsing and resolution — the flow, the base, the viewport, where it lands — and
// all of it can be wrong in ways that produce a confident run against nothing. Chrome is
// the one dependency this repo's suite cannot assume, so without this the whole command
// would be covered only on machines that happen to have it.
if (has('--dry-run') || has('-n')) {
  console.log(`fleet-shots: dry run — ${flow.steps.length} step(s), ${VW}x${VH}` + (BASE ? `, base ${BASE}` : ', no base'));
  console.log(`fleet-shots: would write ${OUT}`);
  for (let i = 0; i < flow.steps.length; i++) {
    const st = flow.steps[i];
    const acts = [st.goto ? `goto ${abs(st.goto)}` : null,
                  st.fill ? `fill ${Object.keys(st.fill).join(',')}` : null,
                  st.click ? `click ${st.click}` : null,
                  st.waitFor ? `waitFor ${st.waitFor}` : null,
                  st.expect ? `expect ${JSON.stringify(st.expect)}` : null].filter(Boolean);
    console.log(`  ${slug(st.name, i)}.png  ${acts.join(' · ') || '(shot only)'}`);
  }
  process.exit(0);
}

// AFTER the dry run, not before. The first version created the output directory during
// argument resolution, so `--dry-run` left a folder behind — a dry run that writes is the
// one thing a dry run must not be, and this repo's destructive commands are dry by default
// precisely so that promise can be relied on.
fs.mkdirSync(OUT, { recursive: true });

// ── the run ──────────────────────────────────────────────────────────────────
// try/finally around the WHOLE run, and no process.exit before the finally has run: a
// browser is ten processes holding a profile open, and this repo has already paid for a
// command that exited past its own cleanup — 266 stranded Chromes and 1.9GB of profile.
let b = null;
const results = [];
let failed = 0;
try {
  try { b = await launch({ width: VW, height: VH, scale: 1 }); }
  catch (e) { die(String(e.message || e)); }

  // Requests, collected per step. Network.enable then listen: the CDP events carry the
  // document and the images too, not just what the app's own JS asked for, which is what
  // makes this able to say "it fetched the wrong URL" about a page that renders fine.
  const reqs = new Map();      // requestId -> { method, url, type }
  let bucket = [];
  b.onEvent((method, p) => {
    if (method === 'Network.requestWillBeSent') {
      reqs.set(p.requestId, { method: p.request?.method || '?', url: p.request?.url || '', type: p.type || '' });
    } else if (method === 'Network.responseReceived') {
      const r = reqs.get(p.requestId);
      if (r) bucket.push({ ...r, status: p.response?.status ?? null, mime: p.response?.mimeType || '' });
    } else if (method === 'Network.loadingFailed') {
      const r = reqs.get(p.requestId);
      // A FAILURE IS A RESULT, not an absence. A request that never answered is exactly
      // the thing a screenshot cannot show, so it is recorded with why.
      if (r) bucket.push({ ...r, status: null, failed: p.errorText || 'failed' });
    }
  });
  await b.call('Network.enable');

  for (let i = 0; i < flow.steps.length; i++) {
    const st = flow.steps[i];
    bucket = [];
    const note = [];
    try {
      if (st.goto) {
        await b.call('Page.navigate', { url: abs(st.goto) });
        // Wait for the document rather than a duration where we can: a fixed sleep racing
        // a load is the flake this repo just spent a day on.
        for (let t = 0; t < 100; t++) {
          const rs = await b.evaluate(() => document.readyState);
          if (rs === 'complete') break;
          await sleep(100);
        }
      }
      if (st.fill) for (const [sel, val] of Object.entries(st.fill)) {
        const ok = await b.evaluate((s, v) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.focus(); el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, sel, val);
        if (!ok) note.push(`no element for fill ${sel}`);
      }
      if (st.click) {
        // element.click() rather than a synthesised mouse event: it is what the app's own
        // handlers listen for, and it does not depend on the element being scrolled into a
        // particular place in a headless viewport. Anything needing a real pointer (a drag,
        // a hover-only menu) is out of scope here and says so rather than half-working.
        const ok = await b.evaluate((s) => {
          const el = document.querySelector(s); if (!el) return false;
          el.scrollIntoView({ block: 'center' }); el.click(); return true;
        }, st.click);
        if (!ok) note.push(`no element for click ${st.click}`);
      }
      if (st.wait) await sleep(Math.min(Number(st.wait) || 0, 30000));
      if (st.waitFor) {
        let seen = false;
        for (let t = 0; t < 100; t++) {
          seen = await b.evaluate((s) => !!document.querySelector(s), st.waitFor);
          if (seen) break;
          await sleep(100);
        }
        if (!seen) note.push(`waitFor never appeared: ${st.waitFor}`);
      }
      // settle: one frame plus a beat, so a transition is not photographed mid-flight
      await sleep(st.settle ?? 350);

      // OBSERVED, not requested. A redirect to a login page photographs perfectly, and the
      // only thing that distinguishes it from the page you asked for is this line.
      const at = await b.evaluate(() => location.href);
      const title = await b.evaluate(() => document.title || '');
      let expect = null;
      if (st.expect) {
        const found = await b.evaluate((t) => document.body?.innerText?.includes(t) ?? false, st.expect);
        expect = { text: st.expect, found };
        if (!found) note.push(`expected text not on the page: ${st.expect}`);
      }
      // A BAD REQUEST IS A NOTE, OR THIS WHOLE COMMAND LIES. The demo that proved the
      // request log worth capturing also proved this: a sign-in POSTing to a path that
      // 404s, with the page showing "Welcome back" and the expect-text found. Screenshot
      // perfect, assertion green, flow broken — and the first version of this file
      // reported "3 steps, 5 requests" and nothing else. A summary that reads as clean
      // over a 404 is worse than no summary, because the summary is what gets pasted.
      //   SCOPED BY TYPE, because not every non-2xx is a defect: a missing favicon is a
      // 404 on every dev server alive and flagging it trains you to ignore the flag. What
      // the page ASKED FOR on purpose — its document, its XHR, its fetch — is the part
      // whose failure means something. The rest is still recorded and still drawn in red
      // on the page; it just does not raise the flow's own hand.
      const MEANT = /^(Document|XHR|Fetch)$/i;
      for (const r of bucket) {
        if (!MEANT.test(r.type || '')) continue;
        if (r.failed) note.push(`${r.method} ${r.url} — ${r.failed}`);
        else if (r.status >= 400) note.push(`${r.method} ${r.url} answered ${r.status}`);
      }
      const shot = await b.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!st.full });
      const file = slug(st.name, i) + '.png';
      fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
      if (note.length) failed++;
      results.push({ n: i + 1, name: st.name || `step ${i + 1}`, file, at, title, expect,
                     notes: note, requests: bucket.slice(0, 200) });
    } catch (e) {
      // A STEP THAT THREW STILL GETS A ROW. Dropping it would make a flow of five steps
      // render as four and look complete.
      failed++;
      results.push({ n: i + 1, name: st.name || `step ${i + 1}`, file: null, at: null, title: null,
                     expect: null, notes: [`step threw: ${String(e.message || e)}`], requests: bucket.slice(0, 200) });
    }
  }
} finally {
  if (b) { try { await b.close(); } catch {} }
}

const manifest = { provenance: prov, steps: results, problems: failed };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'index.html'), page(manifest));

// The path, then the summary — the same order fleet-look prints in, and for the same
// reason: the path is what the next action needs.
console.log(path.join(OUT, 'index.html'));
console.log(`fleet-shots: ${results.length} step${results.length === 1 ? '' : 's'}` +
  `, ${results.reduce((a, r) => a + r.requests.length, 0)} requests` +
  (failed ? `, ${failed} STEP${failed === 1 ? '' : 'S'} WITH SOMETHING TO LOOK AT` : '') +
  (prov.commit ? ` · ${prov.commit.slice(0, 8)}${prov.dirty ? '+dirty' : ''}` : ''));
if (failed) console.log('fleet-shots: a step with a note is NOT a pass — open the page and read it');

// ── the review page ──────────────────────────────────────────────────────────
// Self-contained on purpose: no CDN, no fonts, no fetch. It has to open over file:// from
// a folder somebody synced, and every one of those would be a silent blank.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function page(m) {
  const p = m.provenance;
  const head = [
    p.branch ? `branch <b>${esc(p.branch)}</b>` : null,
    p.commit ? `commit <b>${esc(p.commit.slice(0, 8))}</b>${p.dirty ? ' <span class="warn">+ uncommitted changes</span>' : ''}` : null,
    p.base ? `against <b>${esc(p.base)}</b>` : null,
    `${p.viewport.width}×${p.viewport.height}`,
    esc(p.at.replace('T', ' ').slice(0, 19)),
  ].filter(Boolean).join(' · ');

  const cards = m.steps.map(s => {
    const reqRows = s.requests.map(r => {
      const cls = r.failed ? 'bad' : (r.status >= 400 ? 'bad' : (r.status >= 300 ? 'warn' : 'ok'));
      const code = r.failed ? esc(r.failed) : (r.status ?? '—');
      return `<tr class="${cls}"><td class="m">${esc(r.method)}</td><td class="s">${esc(code)}</td><td class="u" title="${esc(r.url)}">${esc(r.url)}</td></tr>`;
    }).join('');
    const notes = s.notes.length
      ? `<div class="notes">${s.notes.map(n => `<div>⚠ ${esc(n)}</div>`).join('')}</div>` : '';
    const exp = s.expect
      ? `<div class="exp ${s.expect.found ? 'ok' : 'bad'}">${s.expect.found ? '✓ found' : '✗ missing'} “${esc(s.expect.text)}”</div>` : '';
    return `<section class="step" data-n="${s.n}">
  <header>
    <span class="num">${s.n}</span>
    <h2>${esc(s.name)}</h2>
    <div class="verdict">
      <button data-v="ok">ok</button><button data-v="problem">problem</button><button data-v="skip">skip</button>
    </div>
  </header>
  <div class="meta">${s.at ? `<code>${esc(s.at)}</code>` : '<em>no page</em>'}${s.title ? ` · ${esc(s.title)}` : ''}</div>
  ${exp}${notes}
  <div class="body">
    <div class="shotwrap">${s.file ? `<a href="${esc(s.file)}" target="_blank"><img src="${esc(s.file)}" alt="${esc(s.name)}" loading="lazy"></a>` : '<div class="noshot">no screenshot — the step threw</div>'}</div>
    <div class="reqs">
      <div class="rh">${s.requests.length} request${s.requests.length === 1 ? '' : 's'}</div>
      ${s.requests.length ? `<div class="rscroll"><table>${reqRows}</table></div>` : '<div class="rnone">none</div>'}
      <textarea placeholder="note (optional)"></textarea>
    </div>
  </div>
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.branch || 'flow')} — review</title>
<style>
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#1a1a18; --dim:#6b6b64; --line:#e3e3dd;
  --accent:#2f5d50; --ok:#2f6b3f; --bad:#a3341f; --warn:#8a6a12; --shot:#eceae4;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#16171a; --panel:#1e2024; --ink:#e8e8e4; --dim:#9a9a92; --line:#2e3136;
  --accent:#7fbfa8; --ok:#7fbf8f; --bad:#e08a72; --warn:#d9b45c; --shot:#121315;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
header.top{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);
  padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:baseline}
header.top h1{margin:0;font-size:17px;letter-spacing:-.01em}
header.top .prov{color:var(--dim);font-size:12.5px;font-variant-numeric:tabular-nums}
header.top .sp{flex:1}
/* A COUNT WHERE IT SCANS. The per-step warning is right beside its evidence, which is where
   it belongs for reading — and useless for deciding whether to read at all. Twelve steps
   scroll; the header does not. */
header.top .flagged{background:var(--bad);color:#fff;font-size:12.5px;font-weight:600;
  padding:3px 9px;border-radius:99px;white-space:nowrap}
button{font:inherit;padding:5px 11px;border:1px solid var(--line);background:var(--panel);
  color:var(--ink);border-radius:6px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.on[data-v=ok]{background:var(--ok);border-color:var(--ok);color:#fff}
button.on[data-v=problem]{background:var(--bad);border-color:var(--bad);color:#fff}
button.on[data-v=skip]{background:var(--dim);border-color:var(--dim);color:#fff}
#copy{border-color:var(--accent);color:var(--accent);font-weight:600}
main{padding:20px;display:flex;flex-direction:column;gap:18px;max-width:1400px;margin:0 auto}
.step{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.step.done-problem{border-color:var(--bad)}
.step.done-ok{border-color:var(--ok)}
.step>header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.num{width:24px;height:24px;flex:none;border-radius:50%;background:var(--shot);color:var(--dim);
  display:grid;place-items:center;font-size:12px;font-variant-numeric:tabular-nums}
.step h2{margin:0;font-size:15px;font-weight:600;flex:1}
.verdict{display:flex;gap:6px}
.meta{padding:8px 16px 0;color:var(--dim);font-size:12.5px;word-break:break-all}
.meta code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.exp{margin:8px 16px 0;font-size:13px}
.exp.ok{color:var(--ok)} .exp.bad{color:var(--bad);font-weight:600}
.notes{margin:8px 16px 0;color:var(--bad);font-size:13px;font-weight:600}
.body{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;padding:12px 16px 16px}
@media (max-width:900px){.body{grid-template-columns:1fr}}
.shotwrap{background:var(--shot);border:1px solid var(--line);border-radius:8px;padding:8px;
  display:grid;place-items:center;min-height:120px}
.shotwrap img{max-width:100%;max-height:70vh;height:auto;object-fit:contain;display:block;border-radius:4px;cursor:zoom-in}
.noshot{color:var(--bad);font-size:13px;padding:24px;text-align:center}
.reqs{display:flex;flex-direction:column;gap:8px;min-width:0}
.rh{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.rscroll{overflow:auto;max-height:280px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
td{padding:3px 7px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.m{white-space:nowrap;color:var(--dim)}
td.s{white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}
td.u{word-break:break-all}
tr.ok td.s{color:var(--ok)} tr.warn td.s{color:var(--warn)} tr.bad td.s{color:var(--bad);font-weight:700}
tr.bad td.u{color:var(--bad)}
.rnone{color:var(--dim);font-size:13px}
textarea{width:100%;min-height:56px;resize:vertical;font:inherit;font-size:13px;padding:7px 9px;
  border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
.warn{color:var(--warn)}
#out{position:sticky;bottom:0;background:var(--panel);border-top:1px solid var(--line);padding:12px 20px}
#out textarea{min-height:90px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head><body>
<header class="top">
  <h1>flow review</h1>
  <div class="prov">${head}</div>
  ${m.problems ? `<div class="flagged">${m.problems} step${m.problems === 1 ? '' : 's'} to look at</div>` : ''}
  <div class="sp"></div>
  <button id="copy">copy the verdict</button>
</header>
<main>${cards}</main>
<div id="out" hidden><textarea readonly></textarea></div>
<script>
// Verdicts live only in this browser: the page is opened over file:// and has nowhere to
// POST to. That is deliberate for now — the thing that has to reach the person who did the
// work is TEXT they can paste, and one button produces it. localStorage is keyed on the
// folder so reopening the same review keeps your marks, and every access is wrapped
// because a file:// origin can refuse storage outright.
var KEY = 'gf.shots.' + location.pathname;
var state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
function paint(sec){
  var n = sec.dataset.n, s = state[n] || {};
  sec.querySelectorAll('.verdict button').forEach(function(b){
    b.classList.toggle('on', b.dataset.v === s.v);
  });
  sec.classList.toggle('done-ok', s.v === 'ok');
  sec.classList.toggle('done-problem', s.v === 'problem');
  var ta = sec.querySelector('.body textarea');
  if (ta && s.note && ta.value !== s.note) ta.value = s.note;
}
document.querySelectorAll('.step').forEach(function(sec){
  sec.querySelectorAll('.verdict button').forEach(function(b){
    b.addEventListener('click', function(){
      var n = sec.dataset.n;
      state[n] = state[n] || {};
      state[n].v = (state[n].v === b.dataset.v) ? null : b.dataset.v;
      save(); paint(sec);
    });
  });
  var ta = sec.querySelector('.body textarea');
  if (ta) ta.addEventListener('input', function(){
    var n = sec.dataset.n; state[n] = state[n] || {}; state[n].note = ta.value; save();
  });
  paint(sec);
});
document.getElementById('copy').addEventListener('click', function(){
  var lines = ['flow review — ${esc((p.branch || '') + (p.commit ? ' ' + p.commit.slice(0, 8) : ''))}'];
  document.querySelectorAll('.step').forEach(function(sec){
    var n = sec.dataset.n, s = state[n] || {};
    var name = sec.querySelector('h2').textContent;
    if (!s.v && !s.note) return;
    lines.push('- [' + (s.v || 'unmarked') + '] ' + n + '. ' + name + (s.note ? ' — ' + s.note : ''));
  });
  if (lines.length === 1) lines.push('(nothing marked)');
  var box = document.getElementById('out');
  box.hidden = false;
  var t = box.querySelector('textarea');
  t.value = lines.join('\\n');
  t.select();
  // A clipboard write can be refused on file://, and a button that silently does nothing
  // is worse than one that shows you the text to copy yourself — which is why the box is
  // revealed either way rather than only on failure.
  try { navigator.clipboard.writeText(t.value); } catch (e) {}
});
</script></body></html>`;
}
