#!/usr/bin/env node
// fleet-shots — walk a flow, record it as one video with a chapter per step, and record
// what each step ASKED FOR.
//
//     fleet-shots --flow <file.json> [--out DIR] [--base URL] [--dry-run] [--stills]
//     fleet-shots <url> [<url> ...]              one step per url, no flow file
//     fleet-shots verdict <dir>                  record the page's copied verdict (stdin)
//     fleet-shots --check <dir>                  exit non-zero unless every step is ok
//     fleet-shots serve [--port N] [--dir D]     a loopback review UI: pictures + approve
//     fleet-shots list [--dir D]                 the same states, as text, for a pane
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
//     <out>/flow.mp4        the whole flow, one chapter per step (flow.webm without h264;
//                           a still per step instead, with --stills or without ffmpeg)
//     <out>/03-<step>.png   a still only where a step failed
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

// EVERYTHING THE RENDERERS TOUCH LIVES ABOVE THE SERVE BLOCK. NOT AESTHETIC. `serve` parks the module
// with `await new Promise(() => {})`, so a `const` written below that point is never
// initialised and every request dies in the temporal dead zone. There is a comment
// twenty lines down saying exactly this about readVerdict and VERDICT — and this file
// still shipped a stylesheet below the park, which failed on the first page served with
// "SKIN is not defined". A warning next to one hazard does not fence the hazard.
// ONE STYLESHEET FOR BOTH SCREENS, because they are one instrument and two stylesheets
// drift — the same reason sessionStatuses is shared between the Projects cards and the
// stack screen. Inlined rather than served as a file: the page must open over file://
// from a folder somebody copied, where a missing stylesheet is a silently unstyled page.
// BACKWARD COMPATIBLE ON PURPOSE. The per-step URL used to be stored as `at` before the
// rename, and folders written then are still on disk and still worth reading — a redesign
// that made yesterday's runs display "no page" would be a regression dressed as a
// refactor.
const stepUrl = (s) => s.url || s.at || '';

const SKIN = `
:root{
  /* Neutrals with a cool cast rather than a pure grey: a mid grey reads as unconsidered,
     and a technical surface wants the bias toward blue rather than toward warm. */
  --paper:#e9ecef; --surface:#f7f8f9; --sunk:#dfe3e8;
  --ink:#10161c; --ink-2:#3d4854; --dim:#6d7885; --line:#c9d1d9; --hair:#dae0e6;
  /* Hue is rationed. --act is the only accent and appears on one control. */
  --act:#0b5cad;
  --ok:#1f7a3d; --warn:#8a5b00; --bad:#a32020;
  --mat:#ffffff;
}
:root:not([data-theme="light"]){}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0e1216; --surface:#151b21; --sunk:#0a0d10;
  --ink:#e6ebf0; --ink-2:#b3bec9; --dim:#7d8894; --line:#2a333c; --hair:#1e252c;
  --act:#5fa8ea;
  --ok:#5cb677; --warn:#d2a047; --bad:#e2695c;
  --mat:#0a0d10;
}}
:root[data-theme="dark"]{
  --paper:#0e1216; --surface:#151b21; --sunk:#0a0d10;
  --ink:#e6ebf0; --ink-2:#b3bec9; --dim:#7d8894; --line:#2a333c; --hair:#1e252c;
  --act:#5fa8ea; --ok:#5cb677; --warn:#d2a047; --bad:#e2695c; --mat:#0a0d10;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font:14px/1.45 "Helvetica Neue",Inter,ui-sans-serif,system-ui,-apple-system,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono,code,td,th,.num{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  font-variant-numeric:tabular-nums}

/* ── the bar ───────────────────────────────────────────────────────────────
   One line, hairline-ruled, no card. A tool's header is a rule and a row of
   facts, not a panel floating over a background. */
.bar{position:sticky;top:0;z-index:9;background:var(--surface);
  border-bottom:1px solid var(--line);display:flex;align-items:center;
  padding:0 14px;height:44px;gap:12px}
/* NOTHING IN THE BAR WRAPS. It is one line by construction: the facts are the only
   flexible part and they ellipsise, so a long branch name shortens itself instead of
   pushing the count and the link onto a second row. */
.bar > *{flex:none}
.bar .who{font-weight:600;letter-spacing:-.01em;padding-right:12px;
  border-right:1px solid var(--line);white-space:nowrap}
.bar .facts{flex:1 1 auto;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dim);
  font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.bar .facts b{color:var(--ink-2);font-weight:500}
.bar .facts .flag{color:var(--warn)}
.bar .count{font-size:12px;font-family:ui-monospace,Menlo,monospace;color:var(--bad);
  font-weight:600;white-space:nowrap;margin-right:12px}
.bar .count.clear{color:var(--dim);font-weight:400}
.bar a.up{font-size:12px;color:var(--dim);text-decoration:none;border-bottom:1px solid var(--line);
  padding-bottom:1px}
.bar a.up:hover{color:var(--ink);border-color:var(--act)}
/* The rail is the whole review at a glance: one segment per step, coloured by its
   verdict, and clickable — so "go back to the one I wasn't sure about" is one press
   rather than four. It is the only place the overview survives now that the list is gone. */
.rail{display:flex;gap:3px;align-items:center}
.rail button{appearance:none;border:0;padding:0;cursor:pointer;width:26px;height:6px;
  border-radius:1px;background:var(--line)}
.rail button:hover{outline:1px solid var(--act);outline-offset:2px}
.rail button.v-ok{background:var(--ok)} .rail button.v-problem{background:var(--bad)}
.rail button.v-skip{background:var(--dim)}
.rail button.here{height:10px}
.bar .pos{font-size:12px;font-family:ui-monospace,Menlo,monospace;color:var(--ink-2);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.bar .state{font-size:11.5px;font-family:ui-monospace,Menlo,monospace;color:var(--dim);margin-right:12px}
.bar .state.bad{color:var(--bad)}

/* ── a step ────────────────────────────────────────────────────────────────
   A ruled band, not a rounded card with a coloured rail. The status lives in a
   fixed left gutter so the eye can run down one column instead of reading
   borders. */
/* ── the stepper ───────────────────────────────────────────────────────────
   ONE STEP AT A TIME, because a scrolling list of five screenshots is skimmed and a
   review that is skimmed is the thing this whole command exists to replace. Every step
   is rendered into the page — it must work over file:// with no round trip — and all but
   the current one is hidden, so navigation costs nothing and the browser has already
   decoded the images. */
.step{display:none;background:var(--paper);padding-bottom:64px}
.step.here{display:block}
.step > .head{display:grid;grid-template-columns:34px 1fr auto;align-items:center;
  gap:10px;padding:9px 14px 9px 0;border-bottom:1px solid var(--hair)}
.step .gut{grid-column:1;justify-self:center;font-family:ui-monospace,Menlo,monospace;
  font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.step h2{margin:0;font-size:14px;font-weight:600;letter-spacing:-.005em}
.step .sub{grid-column:2;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
  color:var(--dim);word-break:break-all;margin-top:2px}
.step.v-ok .gut{color:var(--ok)} .step.v-problem .gut{color:var(--bad)}
.step.v-ok{background:color-mix(in srgb,var(--ok) 4%,var(--paper))}
.step.v-problem{background:color-mix(in srgb,var(--bad) 5%,var(--paper))}

/* the verdict: three plain segments, one control. Not three coloured pills. */
.verdict{display:inline-flex;border:1px solid var(--line);border-radius:3px;overflow:hidden}
.verdict button{appearance:none;border:0;background:transparent;color:var(--ink-2);
  font:inherit;font-size:12.5px;padding:4px 12px;cursor:pointer;
  border-right:1px solid var(--line)}
.verdict button:last-child{border-right:0}
.verdict button:hover{background:var(--sunk);color:var(--ink)}
.verdict button.on{background:var(--act);color:#fff;border-color:var(--act)}
.verdict button.on[data-v=problem]{background:var(--bad)}
.verdict button.on[data-v=skip]{background:var(--dim)}

/* ── the finding lines ──────────────────────────────────────────────────── */
.lines{padding:7px 14px 0 34px;display:flex;flex-direction:column;gap:3px}
.lines div{font-size:12.5px}
.lines .exp-ok{color:var(--ok)} .lines .exp-bad{color:var(--bad);font-weight:600}
.lines .exp-note{color:var(--dim);font-weight:400}
.lines .note{color:var(--bad);font-weight:600}

/* ── the body: picture, then calls ───────────────────────────────────────── */
.body{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(300px,1fr);
  gap:14px;padding:10px 14px 16px 34px}
@media (max-width:940px){.body{grid-template-columns:1fr}}
/* A MAT, NOT A CARD. A hairline and a light ground behind the shot, the way a print is
   presented — so the picture has an edge without the page growing another rounded box. */
.mat{background:var(--mat);border:1px solid var(--line);padding:6px;
  display:grid;place-items:center;min-height:90px}
.mat img{max-width:100%;max-height:74vh;height:auto;object-fit:contain;display:block;cursor:zoom-in}
.mat .none{color:var(--bad);font-size:12.5px;padding:22px;text-align:center}

.calls{min-width:0;display:flex;flex-direction:column;gap:6px}
.calls .cap{display:flex;justify-content:space-between;align-items:baseline;
  font-size:11.5px;color:var(--dim);font-family:ui-monospace,Menlo,monospace}
.calls .scroll{max-height:74vh;overflow:auto;border-top:1px solid var(--line);
  border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:11.5px;line-height:1.5}
th{text-align:left;font-weight:500;color:var(--dim);padding:4px 8px 4px 0;
  border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--paper)}
td{padding:2px 8px 2px 0;border-bottom:1px solid var(--hair);vertical-align:top;color:var(--ink-2)}
tr:last-child td{border-bottom:0}
td.m{white-space:nowrap;color:var(--dim);width:1%}
td.s{white-space:nowrap;text-align:right;width:1%;padding-right:10px}
td.u{word-break:break-all}
/* Colour ONLY where something is wrong. A green 200 on every row is decoration and it
   makes the one 404 harder to find, not easier. */
tr.ok td.s{color:var(--dim)}
tr.warn td.s{color:var(--warn)}
tr.bad td.s{color:var(--bad);font-weight:700} tr.bad td.u{color:var(--bad)}
.calls textarea{width:100%;min-height:46px;resize:vertical;font:inherit;font-size:12.5px;
  padding:6px 8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);
  border-radius:2px}
.calls textarea:focus{outline:2px solid var(--act);outline-offset:-1px;border-color:var(--act)}
/* THE RULE HAS TO BE VISIBLE AT THE MOMENT IT BITES. A run-raised flag clears only with a
   REASON — so a click cannot launder a measured failure — and the first version enforced
   that silently: you could mark every step, see the index still red, and have nothing on
   screen explain why or what to do. Reported exactly that way. The rule is right; being
   invisible made it indistinguishable from a bug. */
.calls .needs{font-size:12.5px;color:var(--warn);border-left:2px solid var(--warn);
  padding:5px 0 5px 8px;margin-top:2px}
.calls .needs code{font-family:ui-monospace,Menlo,monospace;color:var(--ink)}
.calls textarea.wants{border-color:var(--warn);outline:1px solid var(--warn);outline-offset:-2px}
.calls .nocalls{font-size:12.5px;color:var(--dim);padding:4px 0}
.calls details.assets{font-size:11.5px;color:var(--dim);
  font-family:ui-monospace,"SF Mono",Menlo,monospace}
.calls details.assets summary{cursor:pointer;padding:3px 0;width:max-content}
.calls details.assets summary:hover{color:var(--ink-2)}
.calls details.assets .ab{color:var(--bad);font-weight:600}
.calls details.assets .scroll{max-height:30vh;margin-top:4px}

/* ── the index: a table, because that is what it is ─────────────────────── */
.runs{width:100%;border-collapse:collapse}
.runs th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;padding:0 12px 6px 0;
  border-bottom:1px solid var(--line);position:static}
.runs td{padding:8px 12px 8px 0;border-bottom:1px solid var(--hair);font-size:12.5px}
.runs tr:hover td{background:var(--surface)}
.runs a{color:var(--ink);text-decoration:none;font-weight:600;font-family:inherit;font-size:13.5px}
.runs a:hover{color:var(--act)}
.runs td.st{width:1%;white-space:nowrap;font-weight:600}
.runs td.st.ok{color:var(--ok)} .runs td.st.warn{color:var(--warn)} .runs td.st.bad{color:var(--bad)}
.runs td.n{width:1%;text-align:right;white-space:nowrap;color:var(--dim)}
.runs td.w{width:1%;white-space:nowrap;color:var(--dim)}
.runs td.b{color:var(--dim)}
.wrap{padding:16px 14px;max-width:1500px}
.foot{border-top:1px solid var(--line);background:var(--surface);padding:9px 14px;
  display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font-size:12px;color:var(--dim)}
.foot .k{font-family:ui-monospace,Menlo,monospace;color:var(--ink-2)}
.foot details{flex-basis:100%;margin-top:4px}
.foot summary{cursor:pointer;width:max-content;color:var(--dim)}
.foot .pr{font-family:ui-monospace,Menlo,monospace;margin-top:4px;word-break:break-all}
.foot .pr b{color:var(--ink-2);font-weight:500}
.empty{color:var(--dim);padding:10px 0}
/* ── the action bar ────────────────────────────────────────────────────────
   Fixed, because the decision is the point of the screen and it must not be something you
   scroll to find. Three verdicts and two directions, with the keys printed on them: a
   reviewer doing twelve steps will use the keyboard by the third one. */
.acts{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--surface);
  border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;padding:9px 14px}
.acts .nav{appearance:none;border:1px solid var(--line);background:transparent;color:var(--ink-2);
  font:inherit;font-size:12.5px;padding:5px 11px;border-radius:3px;cursor:pointer}
.acts .nav:hover:not(:disabled){border-color:var(--act);color:var(--ink)}
.acts .nav:disabled{opacity:.35;cursor:default}
.acts .mid{flex:1;display:flex;justify-content:center;gap:8px}
.acts .v{appearance:none;border:1px solid var(--line);background:transparent;
  font:inherit;font-size:13px;padding:6px 16px;border-radius:3px;cursor:pointer;color:var(--ink)}
.acts .v kbd{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dim);
  margin-left:7px;border:1px solid var(--line);border-radius:2px;padding:0 3px}
.acts .v:hover{border-color:var(--act)}
.acts .v.approve.on{background:var(--ok);border-color:var(--ok);color:#fff}
.acts .v.changes.on{background:var(--bad);border-color:var(--bad);color:#fff}
.acts .v.skip.on{background:var(--dim);border-color:var(--dim);color:#fff}
.acts .v.on kbd{color:#fff;border-color:rgba(255,255,255,.4)}
/* ── the end ───────────────────────────────────────────────────────────────── */
.done{display:none;padding:26px 14px 80px;max-width:760px}
.done.here{display:block}
.done h2{margin:0 0 12px;font-size:16px}
.done table{width:100%;border-collapse:collapse;margin-bottom:16px}
.done td{padding:5px 10px 5px 0;border-bottom:1px solid var(--hair);font-size:12.5px}
.done td.v{width:1%;white-space:nowrap;font-weight:600;
  font-family:ui-monospace,Menlo,monospace}
.done td.v.ok{color:var(--ok)} .done td.v.problem{color:var(--bad)} .done td.v.skip{color:var(--dim)}
.done td.v.none{color:var(--warn)}
.done .gate{border:1px solid var(--line);padding:11px 13px;font-size:13px;margin-bottom:14px}
.done .gate.pass{border-color:var(--ok);color:var(--ok)}
.done .gate.fail{border-color:var(--bad);color:var(--bad)}
.done .how{font-size:12.5px;color:var(--dim);margin-bottom:7px}
.done .how code{font-family:ui-monospace,Menlo,monospace;color:var(--ink);
  background:var(--sunk);padding:1px 5px}
.done textarea{width:100%;min-height:96px;font-family:ui-monospace,Menlo,monospace;
  font-size:11.5px;padding:8px;border:1px solid var(--line);background:var(--paper);
  color:var(--ink);border-radius:2px}
#out{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:10px 14px}
#out .how{font-size:12px;color:var(--dim);margin-bottom:6px}
#out .how code{font-family:ui-monospace,Menlo,monospace;color:var(--ink)}
#out textarea{width:100%;min-height:80px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
  padding:7px;border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:2px}`;

// THE RECORDED-RUN PAGE WEARS THE PHONE CLIENT'S CLOTHES. Its tokens are web/app.css's own
// — the terminal palette and the monospace face — copied by value, because this page must
// open over file:// from a copied folder, where a <link> to the client's stylesheet is a
// page with no styles. The colours are locked there, so they are locked here: change them
// in app.css first, then here, and test/run.sh compares the two.
const FLOWSKIN = `
:root{
  --bg:#0b0d10; --fg:#c9d1d9; --dim:#8a8a8a; --hair:#1c2128;
  --red:#ff5f5f; --green:#87d787; --cyan:#5fd7d7; --yellow:#ffd75f; --grey:#8a8a8a; --white:#ffffff;
  --btn:#14181d;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);overflow-x:clip}
body{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  font-size:14px;line-height:1.35;-webkit-text-size-adjust:100%}
button{font:inherit;color:var(--fg);background:var(--btn);border:1px solid var(--hair);
  padding:.45em .7em;border-radius:2px;cursor:pointer;max-width:100%}
button:disabled{opacity:.4;cursor:default}
button.go{color:var(--bg);background:var(--cyan);border-color:var(--cyan);font-weight:700}
button.danger{color:var(--red);border-color:#40202a}
button.on.go{box-shadow:0 0 0 2px var(--bg),0 0 0 3px var(--cyan)}
button.on.danger{color:var(--bg);background:var(--red);border-color:var(--red);font-weight:700}
kbd{font:inherit;font-size:11px;color:var(--dim);margin-left:.5em}
button.go kbd,button.on.danger kbd{color:inherit;opacity:.7}
textarea,input{font:inherit;font-size:13px;color:var(--fg);background:#0f1216;border:1px solid var(--hair);
  border-radius:2px;padding:.45em .55em;width:100%}
textarea:focus,input:focus{outline:none;border-color:var(--cyan)}
a{color:var(--cyan)}

/* the bar: one line, it never wraps; the facts ellipsise */
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;min-width:0;
  padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;background:var(--bg);border-bottom:1px solid var(--hair)}
.bar .who{color:var(--white);font-weight:700;flex:none}
.bar .facts{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim);font-size:12px}
.bar .facts b{color:var(--fg);font-weight:600}
.bar .facts .flag{color:var(--yellow)}
.bar a.up{flex:none;font-size:12px;color:var(--dim)}
.chip{font-size:11.5px;padding:1px 7px;border-radius:999px;white-space:nowrap;flex:none;
  color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.chip.ok{--c:var(--green)} .chip.bad{--c:var(--red)} .chip.warn{--c:var(--yellow)} .chip.none{--c:var(--grey)}

/* the layout: video beside the chapters on a desk, stacked on a phone */
main{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:12px;max-width:1500px;margin:0 auto}
@media (min-width:900px){ main{grid-template-columns:minmax(0,1fr) minmax(320px,400px);align-items:start} }
.player{min-width:0}
@media (min-width:900px){ .player{position:sticky;top:52px} }
.screen{background:#000;border:1px solid var(--hair);border-radius:10px;overflow:hidden;display:flex;justify-content:center}
.screen video{display:block;width:100%;max-height:calc(100dvh - 250px);object-fit:contain;background:#000}
@media (max-width:899px){ .screen video{max-height:70dvh} }
.transport{display:flex;align-items:center;gap:10px;margin-top:8px;min-width:0}
.transport button{flex:none;white-space:nowrap}
.transport .t{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.transport .now{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--white)}
/* the chapter strip: one segment per chapter, as long as it plays, coloured by what the
   run found — the whole flow at a glance, and a click is a jump */
.strip{display:flex;gap:2px;height:10px;margin-top:8px;position:relative}
.strip button{padding:0;border:0;border-radius:1px;height:100%;min-width:4px;background:var(--hair)}
.strip button.flag{background:color-mix(in srgb,var(--red) 55%,var(--hair))}
.strip button.here{outline:1px solid var(--cyan);outline-offset:1px}
.strip .head{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--white);pointer-events:none;left:0}
.keys{color:var(--dim);font-size:12px;margin-top:8px}
.keys b{color:var(--fg);font-weight:600}

/* the chapters: cards, with the phone's status rail */
.chapters{display:flex;flex-direction:column;gap:8px;min-width:0}
.chapters h2{font-size:12px;color:var(--dim);font-weight:400;margin:0 2px 2px;text-transform:none}
.ch{--c:var(--green);background:rgba(255,255,255,.03);border:1px solid var(--hair);border-left:3px solid var(--c);
  border-radius:10px;padding:9px 11px;min-width:0}
.ch.flag{--c:var(--red)}
.ch.here{border-color:color-mix(in srgb,var(--cyan) 55%,var(--hair));border-left-color:var(--c);background:rgba(95,215,215,.05)}
.ch .top{display:flex;align-items:baseline;gap:.5em;min-width:0;cursor:pointer}
.ch .n{color:var(--dim);flex:none;font-variant-numeric:tabular-nums}
.ch .name{color:var(--white);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch .at{margin-left:auto;color:var(--dim);font-size:12px;flex:none;font-variant-numeric:tabular-nums}
.ch .where{color:var(--dim);font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch .found{font-size:12px;margin-top:5px;color:var(--green)}
.ch .found.miss{color:var(--red)}
.ch .note{font-size:12px;margin-top:5px;color:var(--red);overflow-wrap:anywhere}
.ch .still{display:block;margin-top:8px;border:1px solid var(--hair);border-radius:6px;overflow:hidden}
.ch .still{width:max-content;max-width:100%}
.ch .still img{display:block;max-width:100%;max-height:260px;width:auto;height:auto}
.ch details{margin-top:6px;font-size:12px;color:var(--dim)}
.ch details summary{cursor:pointer}
.ch .reqs{overflow-x:auto;margin-top:4px}
.ch .reqs table{border-collapse:collapse;font-size:11.5px;white-space:nowrap}
.ch .reqs td{padding:1px 8px 1px 0;color:var(--fg)}
.ch .reqs tr.bad td{color:var(--red)} .ch .reqs tr.warn td{color:var(--yellow)}
.ch textarea{margin-top:8px;min-height:2.6em;resize:vertical;display:none}
.ch.here textarea,.ch.has textarea,.ch.flag textarea{display:block}
.ch textarea.wants{border-color:var(--yellow)}
.ch .needs{font-size:12px;color:var(--yellow);margin-top:4px}

/* the verdict: pinned to the bottom, because it is the one thing every visit ends with */
.verdict{position:sticky;bottom:0;z-index:5;background:var(--bg);border-top:1px solid var(--hair);
  padding:10px 12px calc(env(safe-area-inset-bottom) + 10px)}
.verdict .row{display:flex;gap:8px;align-items:center;max-width:1500px;margin:0 auto;min-width:0}
.verdict input{flex:1 1 auto;min-width:0}
.verdict .gate{max-width:1500px;margin:6px auto 0;font-size:12px;color:var(--dim)}
.verdict .gate.pass{color:var(--green)} .verdict .gate.fail{color:var(--yellow)} .verdict .gate.rej{color:var(--red)}
.verdict .saved{font-size:12px;color:var(--dim);white-space:nowrap}
.verdict .saved.bad{color:var(--red)}
.paste{max-width:1500px;margin:8px auto 0;font-size:12px;color:var(--dim)}
.paste textarea{display:block;margin-top:4px;min-height:4.5em;font-size:11.5px}
@media (max-width:560px){
  .verdict .row{flex-wrap:wrap}
  .verdict input{flex-basis:100%}
  .verdict .row button{flex:1 1 0}
  kbd{display:none}
}`;

// ── the verdict, and the gate ────────────────────────────────────────────────
// A REVIEW THAT CANNOT SAY NO IS A CEREMONY. Marking steps in the page and copying the
// text is where this started, and it is genuinely useful — but nothing stopped a worker
// calling itself done over a step marked `problem`, which makes the review a courtesy
// rather than a check. These two verbs are the gate:
//
//     pbpaste | fleet-shots verdict <dir>     record what the page's copy button produced
//     fleet-shots --check <dir>               exit non-zero unless every step is ok
//
// STILL NO SERVER, and no POST from the page: a file:// origin cannot reach anything, and
// a server is a process to leak. The channel is the clipboard, which is the one the human
// was already using — the page's button builds the text, one command consumes it.
//
// SILENCE IS NOT APPROVAL. --check fails on an UNREVIEWED step exactly as it fails on a
// rejected one, because the whole point of the standing contract's "name the criterion you
// could not check" is that an unchecked thing must not read as a passed thing. A run of
// twelve steps with two marked ok is not 2/2.
const VERDICT = 'verdict.json';
const readManifest = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { die(`no manifest.json in ${dir} — is that a fleet-shots folder?`); }
};
const readVerdict = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, VERDICT), 'utf8')); } catch { return {}; }
};

// ── two kinds of run, one answer ────────────────────────────────────────────
// A RECORDED run (manifest.video) is reviewed as ONE thing: the flow is approved or
// rejected, and each chapter may carry a note. A run from before the recording has a still
// per step and a verdict per step. Both are on disk and both stay readable, so every
// reader of "what state is this run in" — list, the index, --check — asks this one
// function rather than growing a second copy of the rule per kind.
//   THE FLAG RULE IS THE SAME FOR BOTH: a step the run itself flagged (a 404, a missed
// expect) is not approved by silence. A note on that chapter is the reason, and the reason
// is what clears it; approving the flow without one leaves it flagged.
const isRecorded = (m) => !!(m && m.video);
const chapterNote = (v, n) => String(((v.chapters || {})[String(n)]) || '').trim();
function runState(m, v) {
  if (isRecorded(m)) {
    const fv = (v.flow || {}).v || '';
    const flagged = m.steps.filter(st => st.notes && st.notes.length && !chapterNote(v, st.n)).length;
    const label = fv === 'reject' ? 'rejected' : !fv ? 'unreviewed' : flagged ? `${flagged} flagged` : 'approved';
    return { total: 1, marked: fv ? 1 : 0, problem: fv === 'reject' ? 1 : 0, flagged, label,
             cls: fv === 'reject' ? 'bad' : (!fv || flagged) ? 'warn' : 'ok',
             text: fv === 'reject' ? 'rejected' : !fv ? 'not reviewed' : flagged ? `${flagged} need a reason` : 'approved' };
  }
  const total = m.steps.length;
  const marked = m.steps.filter(st => (v[String(st.n)] || {}).v).length;
  const problem = m.steps.filter(st => (v[String(st.n)] || {}).v === 'problem').length;
  const flagged = m.steps.filter(st => st.notes && st.notes.length &&
    !(['ok', 'skip'].includes((v[String(st.n)] || {}).v) && ((v[String(st.n)] || {}).note || '').trim())).length;
  const label = problem ? `${problem} problem` : flagged ? `${flagged} flagged`
    : marked < total ? `${total - marked} unreviewed` : 'approved';
  // ACTIONABLE, NOT MERELY RED. "2 flagged" on a run where every step was marked reads
  // as a broken screen: the reviewer did everything offered and it stayed red. When the
  // only thing left is a missing reason, say THAT — it is a different job from reviewing.
  const text = problem ? `${problem} needs changes` : marked < total ? `${total - marked} unreviewed`
    : flagged ? `${flagged} need a reason` : 'approved';
  return { total, marked, problem, flagged, label, text,
           cls: problem ? 'bad' : (marked < total || flagged) ? 'warn' : 'ok' };
}

if (ARGV[0] === 'verdict') {
  const dir = path.resolve(ARGV[1] || die('usage: fleet-shots verdict <dir>   (text on stdin)'));
  const m = readManifest(dir);
  const text = fs.readFileSync(0, 'utf8');
  if (isRecorded(m)) {
    // A RECORDED RUN'S TEXT: `- [approve] flow — note` (or reject), then one
    // `- [note] 3. the chapter — text` per chapter with something to say. Same tolerance as
    // below: unknown lines are ignored, and a chapter this run does not have is skipped.
    const out = { flow: null, chapters: {} };
    for (const line of text.split('\n')) {
      const f = line.match(/^\s*-\s*\[(approve|reject)\]\s*flow\b\s*(?:—\s*(.*))?$/i);
      if (f) { out.flow = { v: f[1].toLowerCase(), note: (f[2] || '').trim() }; continue; }
      const c = line.match(/^\s*-\s*\[note\]\s*(\d+)\.\s*[^—]*—\s*(.+)$/i);
      if (c && m.steps.some(x => x.n === Number(c[1]))) out.chapters[c[1]] = c[2].trim();
    }
    if (!out.flow) die('no `- [approve] flow` or `- [reject] flow` line on stdin — copy the verdict from the page first');
    fs.writeFileSync(path.join(dir, VERDICT), JSON.stringify(out, null, 2));
    const nn = Object.keys(out.chapters).length;
    console.log(`fleet-shots: recorded the flow as ${out.flow.v}d` +
                (nn ? `, with ${nn} chapter note${nn === 1 ? '' : 's'}` : '') + ` in ${path.join(dir, VERDICT)}`);
    process.exit(0);
  }
  // The page emits `- [ok] 3. the dashboard` and `- [problem] 2. after signing in — note`.
  // Parsed rather than eval'd, and unknown lines are IGNORED rather than rejected: the
  // clipboard will contain the header line, and one day a line this does not know about.
  const out = readVerdict(dir);
  let n = 0;
  for (const line of text.split('\n')) {
    const mm = line.match(/^\s*-\s*\[([a-z]+)\]\s*(\d+)\.\s*(.*)$/i);
    if (!mm) continue;
    const v = mm[1].toLowerCase();
    if (!['ok', 'problem', 'skip'].includes(v)) continue;
    const step = Number(mm[2]);
    if (!m.steps.some(x => x.n === step)) continue;    // a number this run does not have
    const rest = mm[3] || '';
    const dash = rest.indexOf('—');
    out[String(step)] = { v, note: dash >= 0 ? rest.slice(dash + 1).trim() : '' };
    n++;
  }
  if (!n) die('nothing recognisable on stdin — copy the verdict from the page first');
  fs.writeFileSync(path.join(dir, VERDICT), JSON.stringify(out, null, 2));
  const bad = Object.entries(out).filter(([, x]) => x.v === 'problem').length;
  console.log(`fleet-shots: recorded ${n} verdict${n === 1 ? '' : 's'} in ${path.join(dir, VERDICT)}` +
              (bad ? ` — ${bad} marked problem` : ''));
  process.exit(0);
}

if (has('--check')) {
  const i = ARGV.indexOf('--check');
  const dir = path.resolve(ARGV[i + 1] || die('usage: fleet-shots --check <dir>'));
  const m = readManifest(dir);
  const v = readVerdict(dir);
  if (isRecorded(m)) {
    // ONE VERDICT, FOR THE FLOW. Silence is still not approval: no verdict fails exactly as
    // a rejection does. And a chapter the run flagged needs its reason even under an
    // approve — the flag rule the per-step review had, carried over whole.
    const fv = v.flow || {};
    const accepted = [], flagged = [];
    for (const st of m.steps.filter(x => x.notes && x.notes.length)) {
      const why = chapterNote(v, st.n);
      if (why) accepted.push({ st, why }); else for (const nt of st.notes) flagged.push({ st, nt });
    }
    for (const [n, note] of Object.entries(v.chapters || {})) {
      const st = m.steps.find(x => String(x.n) === n);
      if (st && !(st.notes || []).length && String(note).trim()) console.log(`note  ${st.n}. ${st.name} — ${note}`);
    }
    for (const { st, nt } of flagged) console.log(`flagged  ${st.n}. ${st.name} — ${nt}` +
      (fv.v === 'approve' ? '   (approved with no reason on this chapter — a note is what clears a flag)' : ''));
    for (const { st, why } of accepted) console.log(`accepted  ${st.n}. ${st.name} — ${why}`);
    if (fv.v === 'approve' && !flagged.length) {
      console.log(`fleet-shots: the flow (${m.steps.length} chapter${m.steps.length === 1 ? '' : 's'}) is approved` +
        (fv.note ? ` — ${fv.note}` : '') +
        (accepted.length ? `, ${accepted.length} flag${accepted.length === 1 ? '' : 's'} accepted with a reason` : ''));
      process.exit(0);
    }
    console.log(fv.v === 'reject' ? `fleet-shots: NOT approved — the flow was rejected${fv.note ? ` — ${fv.note}` : ''}`
      : !fv.v ? 'fleet-shots: NOT approved — the flow has not been reviewed'
      : `fleet-shots: NOT approved — ${flagged.length} flagged by the run itself, with no reason given`);
    process.exit(1);
  }
  const problems = [], unreviewed = [];
  for (const st of m.steps) {
    const got = v[String(st.n)];
    if (!got || !got.v) { unreviewed.push(st); continue; }
    if (got.v === 'problem') problems.push({ st, note: got.note });
    // `skip` is a REVIEWED state, deliberately: a human looked and said this one does not
    // apply. Treating it as unreviewed would make the honest answer impossible to give.
  }
  for (const { st, note } of problems) console.log(`problem  ${st.n}. ${st.name}${note ? ` — ${note}` : ''}`);
  for (const st of unreviewed) console.log(`unreviewed  ${st.n}. ${st.name}`);
  // THE FLOW'S OWN FINDINGS COUNT TOO, and they are OVERRIDABLE — but only on the record.
  // A step nobody marked whose POST answered 404 is not approved by silence. Yet a flag
  // that can never be cleared makes this un-passable, and a gate nobody can get past is a
  // gate people route around: sometimes the 404 really is fine and the reviewer is the one
  // who knows it. The page draws the flag in red directly above the buttons, so an `ok`
  // there is an INFORMED override, which is exactly how a linter suppression works.
  //   The price is a reason. `ok` or `skip` WITH A NOTE clears the flag and the note is
  // printed, so the override survives in the output rather than evaporating into a click;
  // `ok` with no note does not clear it, and says what is missing.
  const noted = [], overridden = [];
  for (const st of m.steps.filter(x => x.notes && x.notes.length)) {
    const got = v[String(st.n)] || {};
    const cleared = (got.v === 'ok' || got.v === 'skip') && (got.note || '').trim();
    if (cleared) overridden.push({ st, note: got.note.trim() });
    else for (const nt of st.notes) {
      noted.push(st);
      console.log(`flagged  ${st.n}. ${st.name} — ${nt}` +
        (got.v === 'ok' || got.v === 'skip' ? '   (marked ' + got.v + ' with no reason — a note is what clears a flag)' : ''));
    }
  }
  for (const { st, note } of overridden) console.log(`accepted  ${st.n}. ${st.name} — ${note}`);
  if (!problems.length && !unreviewed.length && !noted.length) {
    console.log(`fleet-shots: all ${m.steps.length} step(s) reviewed and ok` +
                (overridden.length ? `, ${overridden.length} flag${overridden.length === 1 ? '' : 's'} accepted with a reason` : ''));
    process.exit(0);
  }
  console.log(`fleet-shots: NOT approved — ${problems.length} problem, ${unreviewed.length} unreviewed, ${noted.length} flagged by the run itself`);
  process.exit(1);
}

// ── the same answer, in a pane ──────────────────────────────────────────────
// A LIST IS NOT A UI FOR PICTURES — you cannot review a screenshot in a terminal, which is
// why the server exists. But "is anything waiting on me" is a text question, and asking it
// should not cost a browser: this is the line you run in a pane beside the grid. It reads
// the same two files --check reads, so it cannot disagree with the gate.
if (ARGV[0] === 'list') {
  const root = path.resolve(flag('--dir') || path.join(
    process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude', 'fleet'), 'shots'));
  let names = [];
  try { names = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'manifest.json'))); } catch {}
  if (!names.length) { console.log(`fleet-shots: nothing in ${root}`); process.exit(0); }
  let waiting = 0;
  for (const d of names.sort().reverse()) {
    const dir = path.join(root, d);
    let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
    // Not ours, so not listed — the same check `serve` makes above, for the same reason
    // and against the same real case: another program's manifest.json in a shared --dir.
    // Here the consequence is quieter and exactly as wrong — it aborts the whole listing
    // on the first foreign file instead of taking a server down.
    if (!m || !Array.isArray(m.steps)) continue;
    const state = runState(m, readVerdict(dir)).label;
    if (state !== 'approved') waiting++;
    const p = m.provenance || {};
    console.log(`${state.padEnd(14)} ${d}  ${p.branch || ''}${p.commit ? ' ' + p.commit.slice(0, 8) : ''}${p.dirty ? '+dirty' : ''}`);
  }
  // THE COUNT LAST, because it is the answer. A list you have to add up yourself is a
  // directory listing with extra steps.
  console.log(waiting ? `fleet-shots: ${waiting} of ${names.length} waiting on you`
                      : `fleet-shots: all ${names.length} approved`);
  process.exit(0);
}

// ── the review server ───────────────────────────────────────────────────────
// LOOPBACK ONLY, AND FOREGROUND. Two constraints, both of them scars rather than taste.
//
//   127.0.0.1 and nothing else. The fleet already has an internet-reachable server —
// fleet-serve, on the tailnet, behind passkeys — and a second one would be a second
// surface guarding a folder of screenshots of your own product. --bind is deliberately
// absent rather than defaulted: an option that CAN open this up is an option somebody
// eventually passes.
//
//   NOT A DAEMON. It runs in the foreground, prints its URL, and dies with the terminal.
// Twenty-odd leaked servers were reaped from this machine in one day, one of them orphaned
// to launchd by a `( … ) &` subshell — so the answer to "how do we not leak another one" is
// that nothing outlives the shell that started it. There is no init, no pidfile, no
// restart-on-crash, on purpose.
if (ARGV[0] === 'serve') {
  const http = await import('node:http');
  const root = path.resolve(flag('--dir') || path.join(
    process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude', 'fleet'), 'shots'));
  const want = Number(flag('--port', 0)) || 0;

  const runs = () => {
    let names = [];
    try { names = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'manifest.json'))); } catch {}
    // Newest first, by name, which IS chronological: the default folder is an ISO stamp.
    // A caller who passed --out gets sorted-by-name, which is the honest fallback rather
    // than an mtime that a later verdict write would reorder under them.
    return names.sort().reverse().map(d => {
      const dir = path.join(root, d);
      let m = null; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
      // ...AND IT HAS TO BE *OURS*. `manifest.json` is one of the most common filenames in
      // computing, and --dir is frequently a directory we do not exclusively own — a shared
      // temp dir, a downloads folder, anywhere a run was written beside other programs'
      // work. The guard above asks only whether the bytes are JSON, which is a PROXY for
      // the real question and lets anything well-formed through.
      //   SEEN LIVE, AND IT TOOK THE WHOLE SERVER DOWN RATHER THAN SKIPPING ONE ROW. A
      // browser update unpacked its components into the directory this was serving, each
      // component directory holding a manifest.json of a completely different schema —
      // valid JSON, no `steps`. The next request read m.steps.length, threw inside the
      // request handler, and node exited 1. From the client that is a connection refused
      // with no body; from here, a review UI that worked in the morning and was dead in the
      // afternoon with nothing in this repo changed. One stranger's file, every run
      // unreachable, and the crash is on the FIRST request rather than at startup — so the
      // process prints its banner, claims a port, and dies the moment it is used.
      //   The general shape: any long-lived scan of a directory you do not own must decide
      // whether each hit is yours by its CONTENT, and must survive the answer being no.
      if (!m || !Array.isArray(m.steps)) return null;
      return { d, m, st: runState(m, readVerdict(dir)) };
    }).filter(Boolean);
  };

  // THE AGENTS, asked for rather than remembered — and allowed to be absent. This screen is
  // useful with no fleet running at all (you review yesterday's flows), so a tmux that is
  // not there must read as "no sessions", never as an error page over the reviews.
  const sessions = () => {
    const out = [];
    try {
      const socks = execFileSync('sh', ['-c', "ls -1 ${TMUX_TMPDIR:-/tmp}/tmux-$(id -u) 2>/dev/null || true"],
        { encoding: 'utf8' }).split('\n').filter(x => x.startsWith('cf-'));
      for (const sock of socks) {
        try {
          const names = execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_name}'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
          for (const n of names) {
            if (/^_(?:term|edit)-/.test(n)) continue;      // a tab is not an agent
            out.push({ project: sock.replace(/^cf-/, ''), name: n });
          }
        } catch {}
      }
    } catch {}
    return out;
  };

  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && u.pathname === '/api/verdict') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let j; try { j = JSON.parse(body); } catch { return send(res, 400, 'text/plain', 'bad json'); }
        // THE PATH COMES FROM A BROWSER, so it is not trusted to be inside root. A verdict
        // POST naming ../../something is the whole of the attack surface here, and the
        // check is one line: resolve it and require the prefix.
        const dir = path.resolve(root, String(j.dir || ''));
        if (dir !== root && !dir.startsWith(root + path.sep)) return send(res, 403, 'text/plain', 'outside the shots dir');
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) return send(res, 404, 'text/plain', 'no such run');
        let rm = null; try { rm = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {}
        if (isRecorded(rm)) {
          // THE FLOW'S VERDICT: approve / reject / none, and a note per chapter. Chapters
          // are checked against the manifest so a stale page cannot write numbers this run
          // does not have; an empty flow verdict is allowed — un-choosing is a real thing.
          const fv = String((j.flow || {}).v || '');
          if (fv && !['approve', 'reject'].includes(fv)) return send(res, 400, 'application/json', '{"ok":false,"error":"flow verdict is approve or reject"}');
          const chapters = {};
          for (const [k, val] of Object.entries(j.chapters || {})) {
            if (!/^[0-9]+$/.test(k) || !rm.steps.some(x => String(x.n) === k)) continue;
            const t = String(val || '').slice(0, 2000);
            if (t.trim()) chapters[k] = t;
          }
          const out = { flow: fv ? { v: fv, note: String((j.flow || {}).note || '').slice(0, 2000) } : null, chapters };
          try { fs.writeFileSync(path.join(dir, VERDICT), JSON.stringify(out, null, 2)); }
          catch (e) { return send(res, 500, 'text/plain', String(e.message || e)); }
          return send(res, 200, 'application/json', JSON.stringify({ ok: true, flow: fv || null, notes: Object.keys(chapters).length }));
        }
        const clean = {};
        for (const [k, val] of Object.entries(j.state || {})) {
          if (!/^[0-9]+$/.test(k)) continue;
          const v = String((val || {}).v || '');
          if (!['ok', 'problem', 'skip'].includes(v)) continue;
          clean[k] = { v, note: String((val || {}).note || '').slice(0, 2000) };
        }
        // A POST THAT STORED NOTHING IS NOT OK, and this said `{"ok":true}` over exactly
        // that: a state whose every entry was rejected got a success and an empty file.
        // The page shows a green `saved` off this reply, so the one thing it must not do
        // is agree when nothing was written. An EMPTY state is different and is allowed —
        // clearing every mark is a real thing to do, and it is what the page sends then.
        const sent = Object.keys(j.state || {}).length;
        if (sent && !Object.keys(clean).length)
          return send(res, 400, 'application/json', '{"ok":false,"error":"no usable verdicts in that state"}');
        try { fs.writeFileSync(path.join(dir, VERDICT), JSON.stringify(clean, null, 2)); }
        catch (e) { return send(res, 500, 'text/plain', String(e.message || e)); }
        send(res, 200, 'application/json', JSON.stringify({ ok: true, stored: Object.keys(clean).length }));
      });
      return;
    }
    if (u.pathname === '/') return send(res, 200, 'text/html', index(runs(), sessions(), root));
    // /r/<run>/...  — the run page, and its images
    const mm = u.pathname.match(/^\/r\/([^/]+)\/?(.*)$/);
    if (mm) {
      const dir = path.resolve(root, decodeURIComponent(mm[1]));
      if (dir !== root && !dir.startsWith(root + path.sep)) return send(res, 403, 'text/plain', 'outside the shots dir');
      const rest = mm[2] || '';
      if (!rest) {
        let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
        catch { return send(res, 404, 'text/plain', 'no such run'); }
        m.dir = decodeURIComponent(mm[1]);
        m.verdict = readVerdict(dir);
        return send(res, 200, 'text/html', page(m, true));
      }
      // Only the files this page references, by extension: the folder is ours, but a path
      // handed over by a browser is not, and "serve whatever is under here" is how a
      // review surface becomes a file browser for the home directory.
      if (!/^[A-Za-z0-9._-]+\.(png|jpg|json|mp4|webm)$/.test(rest)) return send(res, 403, 'text/plain', 'not a shot');
      const type = { png: 'image/png', jpg: 'image/jpeg', json: 'application/json', mp4: 'video/mp4', webm: 'video/webm' }[rest.split('.').pop()];
      let size = 0; try { size = fs.statSync(path.join(dir, rest)).size; } catch { return send(res, 404, 'text/plain', 'not found'); }
      // RANGES, OR THE CHAPTERS DO NOT WORK. A <video> seeks by asking for a byte range.
      // Measured: served whole, with a 200 and no Accept-Ranges, every seek was refused, so
      // → and a chapter click both left the video at 0:00 — a chapter list that looks
      // right and does nothing.
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (rg && (rg[1] || rg[2])) {
        let a = rg[1] ? Number(rg[1]) : Math.max(0, size - Number(rg[2]));
        let z = rg[1] && rg[2] ? Math.min(Number(rg[2]), size - 1) : size - 1;
        if (a >= size || a > z) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { 'content-type': type, 'content-length': z - a + 1, 'accept-ranges': 'bytes',
                             'content-range': `bytes ${a}-${z}/${size}`, 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(dir, rest), { start: a, end: z }).pipe(res);
      }
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(dir, rest)).pipe(res);
    }
    send(res, 404, 'text/plain', 'not found');
  });
  server.on('error', (e) => die(`cannot listen: ${e.message}`));
  server.listen(want, '127.0.0.1', () => {
    const a = server.address();
    console.log(`http://127.0.0.1:${a.port}/`);
    console.log(`fleet-shots: serving ${root} — loopback only, and it dies with this terminal (Ctrl-C)`);
  });
  // A drain on the way out, for the reason fleet-serve documents about truncation: a
  // socket write is asynchronous, so exiting while a PNG is still going out cuts it at the
  // pipe buffer with no error either side.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  });

  // PARKED, and both halves of that matter. Without it the module falls through into the
  // flow parser, which finds no URL and calls die() — the server would print its address
  // and vanish half a second later. And it is parked HERE, after the gate, because
  // readVerdict and VERDICT are `const`: declared below this point they would never be
  // initialised, since a parked module never finishes evaluating, and the first request
  // would throw ReferenceError from inside a handler nobody is watching.
  await new Promise(() => {});
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
// A CLEAN TREE IS NOT AN UNKNOWN TREE, and the first version could not tell them apart:
// `git status --porcelain !== '' || null` gave **null** for a clean checkout, because
// `false || null` is null — the same answer it gives when git is absent or errored. Every
// other field here is allowed to be null precisely because null means "not determined", so
// spending it on "determined, and clean" destroys the only distinction that mattered.
// Reported from a real run as `dirty: null` on a tree the reporter knew was dirty, and
// they could not tell which of the two it meant.
const gitOk = git('rev-parse', '--is-inside-work-tree') === 'true';
const prov = {
  commit: git('rev-parse', 'HEAD') || null,
  branch: git('rev-parse', '--abbrev-ref', 'HEAD') || null,
  dirty: gitOk ? git('status', '--porcelain') !== '' : null,
  repo: git('rev-parse', '--show-toplevel') || null,
  base: BASE || null,
  viewport: { width: VW, height: VH },
  at: new Date().toISOString(),
  session: process.env.CLAUDE_FLEET_SLOT || null,
  // ASKED FOR, NOT READ OUT OF AN ENV VAR THAT DOES NOT EXIST. `slot` was
  // CLAUDE_FLEET_SLOT_PORT, which nothing sets — so it was null in every run ever recorded
  // while `fleet-slot of <path>` answered perfectly well. A field that is structurally
  // always null is worse than an absent one: it reads as "this checkout has no slot".
  //   fleet-slot allocates the INTEGER and nothing else; the repo's own boot script is
  // what turns it into ports. So the integer is what goes here, and the ports it implies
  // are deliberately not guessed.
  slot: (() => {
    for (const bin of [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-slot'), 'fleet-slot']) {
      try {
        const v = execFileSync(bin, ['of', process.cwd()],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (/^[0-9]+$/.test(v)) return Number(v);
      } catch {}
    }
    return null;
  })(),
};

const slug = (s, i) => `${String(i + 1).padStart(2, '0')}-` +
  // Trimmed back to the last whole word rather than cut at 40, which produced names like
  // `...-in-the-bui`. Cosmetic only: the step NUMBER is the prefix, so two steps sharing a
  // long name cannot collide — the filename is unique before the slug is even appended.
  (String(s || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40).replace(/-[a-z0-9]{1,3}$/, '').replace(/-$/, '') || 'step');
const abs = (u) => (/^https?:\/\//.test(u) ? u : (BASE ? BASE.replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u) : u));

// ── the recording ────────────────────────────────────────────────────────────
// ONE VIDEO OF THE WHOLE FLOW, with each step as a chapter, instead of a still per step. A
// folder of stills shows where each step ENDED; it cannot show a spinner that never
// stopped, a flash of the wrong screen between two right ones, or a button that took three
// seconds to answer — and those are what a reviewer clicking through by hand would have
// seen. Chrome's screencast gives the frames; ffmpeg turns them into a file every browser
// (and a phone) plays.
//   WITHOUT FFMPEG THIS SAYS SO AND FALLS BACK to the stills it always took, rather than
// failing a review for a missing encoder or writing frames nobody can play. --stills asks
// for that fallback on purpose.
//   STILLS ONLY WHERE A STEP FAILED, when there is a video: the video already shows every
// screen, and a still beside the failure is what a note quoting it needs to point at.
function encoder() {
  if (has('--stills')) return null;
  const ff = process.env.FFMPEG || 'ffmpeg';
  let list = '';
  try { list = execFileSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
  // H.264 in mp4 first: it is the one every browser AND iOS plays. VP9/webm otherwise.
  if (/\blibx264\b/.test(list)) return { ff, file: 'flow.mp4', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart'] };
  if (/\blibvpx-vp9\b/.test(list)) return { ff, file: 'flow.webm', args: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-deadline', 'realtime'] };
  return null;
}
const ENC = encoder();

// A DRY RUN, SO THE ARGUMENT SURFACE IS TESTABLE WITHOUT A BROWSER. Everything above this
// line is parsing and resolution — the flow, the base, the viewport, where it lands — and
// all of it can be wrong in ways that produce a confident run against nothing. Chrome is
// the one dependency this repo's suite cannot assume, so without this the whole command
// would be covered only on machines that happen to have it.
if (has('--dry-run') || has('-n')) {
  console.log(`fleet-shots: dry run — ${flow.steps.length} step(s), ${VW}x${VH}` + (BASE ? `, base ${BASE}` : ', no base'));
  console.log(`fleet-shots: would write ${OUT}`);
  console.log(ENC ? `fleet-shots: records ${ENC.file}, one chapter per step; a still only where a step fails`
                  : `fleet-shots: ${has('--stills') ? '--stills' : 'no ffmpeg with an h264 or vp9 encoder'} — a still per step, no video`);
  for (let i = 0; i < flow.steps.length; i++) {
    const st = flow.steps[i];
    // EVERY VERB THE STEP CARRIES, INCLUDING THE TIMING ONES. The first version listed
    // goto/fill/click/waitFor/expect and silently dropped wait, settle and full — so a
    // step written with `settle: 1500` printed a plan that looked like it had no settle,
    // and there was no way to tell "honoured but unprinted" from "ignored". Reported from
    // a real dogfood run, and it is the wrong silence for this command in particular:
    // `settle` is exactly the knob you reach for when a shot caught a mid-render frame,
    // so it is the one whose effect you most need to see confirmed.
    const acts = [st.goto ? `goto ${abs(st.goto)}` : null,
                  st.fill ? `fill ${Object.keys(st.fill).join(',')}` : null,
                  st.click ? `click ${st.click}` : null,
                  st.waitFor ? `waitFor ${st.waitFor}` : null,
                  st.wait ? `wait ${Number(st.wait)}ms` : null,
                  st.settle !== undefined ? `settle ${Number(st.settle)}ms` : null,
                  st.full ? 'full page' : null,
                  st.expect ? `expect ${JSON.stringify(st.expect)}` : null].filter(Boolean);
    console.log(`  ${slug(st.name, i)}.png${ENC ? ' (if it fails)' : ''}  ${acts.join(' · ') || '(shot only)'}`);
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
const frames = [];
let rec0 = 0, recEnd = 0;
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

  // THE FRAMES, each with the wall-clock second Chrome swapped it in. The screencast only
  // sends a frame when the screen CHANGES, so a still screen is one frame held — which is
  // why every frame keeps its timestamp: a frame's duration is the gap to the next one, and
  // a video built at a fixed rate from these would play a ten-second wait in a blink.
  //   Every frame is ACKED, or Chrome stops sending after the first few.
  if (ENC) {
    b.onEvent((method, p) => {
      if (method !== 'Page.screencastFrame') return;
      frames.push({ data: p.data, ts: p.metadata?.timestamp || Date.now() / 1000 });
      b.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
  }
  // STARTED ONCE THE FIRST PAGE HAS LOADED, not before it: the tab opens on about:blank, and
  // a recording started there opened every review on a dark frame — measured at 0:00 of a
  // real run, luminance 18 of 255, with the sign-in page arriving half a second later.
  const startRec = async () => {
    if (!ENC || rec0) return;
    await b.call('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: VW, maxHeight: VH, everyNthFrame: 1 });
    rec0 = Date.now() / 1000;
  };

  for (let i = 0; i < flow.steps.length; i++) {
    const st = flow.steps[i];
    bucket = [];
    const note = [];
    // THE CHAPTER STARTS BEFORE THE STEP ACTS, with a beat of the screen as it was, so a
    // jump to "after signing in" shows the click land rather than opening on its result.
    const start = ENC ? (rec0 ? Date.now() / 1000 - rec0 : 0) : null;
    if (ENC && rec0) await sleep(400);
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
      await startRec();
      if (st.fill) for (const [sel, val] of Object.entries(st.fill)) {
        // THE NATIVE SETTER, NOT `el.value = v`, AND THIS WAS A REAL BUG WITH TEETH.
        // React puts a `_valueTracker` on the node. Assigning `.value` updates that tracker
        // as a side effect, so when the `input` event arrives React compares the node's
        // value against its own cached copy, sees no change, and SUPPRESSES the synthetic
        // onChange — the component's state setter never runs. The property descriptor's
        // setter goes round the tracker, which is why every browser-testing library reaches
        // for it.
        //   REPORTED FROM A REAL RUN, and the shape of the failure is the reason this
        // matters here more than in most tools: the screenshot showed the typed text
        // sitting in the search box with the list below it COMPLETELY UNFILTERED. A reader
        // flipping through shots would say "yes, it searched". That is this command's own
        // thesis — a page that renders success while nothing happened looks identical to one
        // that worked — occurring inside the instrument.
        //   AND A FILL THAT LANDS BUT IS IGNORED WAS SILENT: the only note was for a missed
        // SELECTOR. So the value is read back and compared, which catches a framework that
        // rejected it, a maxlength that truncated it, and an input that is readonly.
        const filled = await b.evaluate((s, v) => {
          const el = document.querySelector(s);
          if (!el) return { found: false };
          el.focus();
          const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
                      : (el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
                      : HTMLInputElement.prototype;
          const d = Object.getOwnPropertyDescriptor(proto, 'value');
          if (d && d.set) d.set.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, readback: String(el.value) };
        }, sel, val);
        if (!filled.found) note.push(`no element for fill ${sel}`);
        else if (filled.readback !== String(val))
          note.push(`fill ${sel} did not stick — asked for ${JSON.stringify(String(val))}, the field holds ${JSON.stringify(filled.readback)}`);
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
      // CSS text-transform MEANS THE AUTHORED CASING IS NOT THE RENDERED CASING, and the
      // first version could never match past it. `innerText` is RENDERED text, so a
      // Tailwind `uppercase` heading comes back shouting: measured in a live page,
      // innerText.includes('FILLED IN WHEN YOU SEND') was true and
      // innerText.includes('Filled in when you send') was false, on the same element.
      //   That makes every uppercase/capitalize heading in any such app unmatchable BY ITS
      // OWN SOURCE TEXT — which is the only string an author has to copy. And it presents
      // as "your app is broken" rather than "your expect cannot see this". A run whose only
      // note is a false negative is worse than a run with no notes, because it spends the
      // reader's trust in the notes that are real. Reported from a real run, and it is the
      // same family as the swallowed fill: the instrument reporting a failure that is its
      // own.
      //   SO: case-insensitive, against innerText.
      //   AND DELIBERATELY NOT textContent AS A FALLBACK, which was the other suggestion.
      // textContent carries text that is not rendered at all — display:none, a
      // visually-hidden label, a clipped panel. Letting that satisfy `expect` would turn a
      // "this is on screen" assertion into "this is somewhere in the DOM", which is a false
      // GREEN, and a false green is the one thing this command exists to refuse. It is used
      // only to EXPLAIN a miss: text in the DOM but not rendered is a different problem
      // from text that is absent, and saying which turns a bare failure into a diagnosis.
      let expect = null;
      if (st.expect) {
        const r = await b.evaluate((t) => {
          const vis = document.body?.innerText ?? '';
          const dom = document.body?.textContent ?? '';
          const lc = String(t).toLowerCase();
          return { exact: vis.includes(t), ci: vis.toLowerCase().includes(lc),
                   inDom: dom.toLowerCase().includes(lc) };
        }, st.expect);
        const found = r.exact || r.ci;
        // `how` is recorded rather than dropped: a match that only worked case-insensitively
        // means the screen says something different from the string you wrote, and a reader
        // comparing the two should be told instead of left to wonder.
        expect = { text: st.expect, found, how: found ? (r.exact ? 'exact' : 'case-insensitive') : null };
        if (!found) note.push(r.inDom
          ? `expected text is in the DOM but NOT RENDERED: ${st.expect} — hidden, clipped, or in a collapsed panel`
          : `expected text not on the page: ${st.expect}`);
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
      let file = null;
      if (!ENC || note.length) {
        const shot = await b.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!st.full });
        file = slug(st.name, i) + '.png';
        fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
      }
      if (note.length) failed++;
      // `url`, NOT `at`. The field held the page's final URL and was named the same thing
      // as `provenance.at`, which is a TIMESTAMP — one key, two meanings, in one document.
      // A careful reader of a real manifest concluded the per-step URL was simply absent
      // and reconstructed the landing pages from the page titles instead. The data was
      // always there; the name was the defect.
      results.push({ n: i + 1, name: st.name || `step ${i + 1}`, file, url: at, title, expect,
                     notes: note, requests: bucket.slice(0, 200), ...(ENC ? { start } : {}) });
    } catch (e) {
      // A STEP THAT THREW STILL GETS A ROW. Dropping it would make a flow of five steps
      // render as four and look complete.
      failed++;
      results.push({ n: i + 1, name: st.name || `step ${i + 1}`, file: null, url: null, title: null,
                     expect: null, notes: [`step threw: ${String(e.message || e)}`], requests: bucket.slice(0, 200),
                     ...(ENC ? { start } : {}) });
    }
  }
  if (ENC && rec0) {
    await sleep(700);                               // the last chapter's end, held
    recEnd = Date.now() / 1000 - rec0;
    try { await b.call('Page.stopScreencast'); } catch {}
  }
} finally {
  if (b) { try { await b.close(); } catch {} }
}

// ── the video ────────────────────────────────────────────────────────────────
// A CONSTANT 25fps SEQUENCE BUILT HERE, not ffmpeg's concat demuxer with a duration per
// frame. The demuxer was the first version, and it is inconsistent about the LAST entry:
// measured on ffmpeg 8, listing the last frame once dropped its 2s hold (a 4.7s flow came
// out 2.8s) and listing it twice — the documented workaround — added the hold AGAIN (6.8s),
// whatever duration the repeat was given. Either way every chapter after the first pointed
// at the wrong moment. Here each output frame is a hard link to the source frame that was on
// screen at that instant, so the file is exactly N/25 seconds and chapter times measured
// from rec0 are the video's own clock.
//   A FAILED ENCODE IS REPORTED AND THE RUN STILL STANDS: the manifest, the notes and the
// requests are the evidence too, and the frames are kept so the encode can be retried.
let video = null, videoNote = null;
if (ENC && frames.length) {
  const fdir = path.join(OUT, '.frames');
  fs.mkdirSync(fdir, { recursive: true });
  frames.forEach((f, k) => fs.writeFileSync(path.join(fdir, `src-${String(k).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64')));
  const N = Math.max(1, Math.round(recEnd * 25));
  let j = 0;
  for (let k = 0; k < N; k++) {
    const t = rec0 + k / 25;
    while (j + 1 < frames.length && frames[j + 1].ts <= t) j++;
    const src = path.join(fdir, `src-${String(j).padStart(6, '0')}.jpg`), dst = path.join(fdir, `${String(k).padStart(6, '0')}.jpg`);
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  }
  try {
    execFileSync(ENC.ff, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '25',
      '-i', path.join(fdir, '%06d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p',
      ...ENC.args, path.join(OUT, ENC.file)], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180000 });
    video = ENC.file;
    fs.rmSync(fdir, { recursive: true, force: true });
  } catch (e) {
    videoNote = `the video did not encode (${String(e.stderr || e.message || e).split('\n')[0].slice(0, 160)}) — frames kept in ${fdir}`;
  }
  // each chapter ends where the next begins; the last where the recording did
  results.forEach((r, k) => { r.end = k + 1 < results.length ? results[k + 1].start : recEnd; });
}
if (ENC && !video) {
  // No video after all: the chapters have nothing to point into, and a recorded-run page
  // over a missing file is a player that never starts. Say why, and keep the run — as the
  // per-step review, with each step's LAST FRAME as its picture, so no step is left with
  // nothing to look at because only the failures took a still.
  console.log(`fleet-shots: ${videoNote || 'no frames were recorded'}`);
  results.forEach((r, k) => {
    delete r.start; delete r.end;
    if (r.file) return;
    const until = rec0 + (k + 1 < results.length ? (results[k + 1].start ?? recEnd) : recEnd);
    const f = [...frames].reverse().find(x => x.ts <= until);
    if (!f) return;
    r.file = slug(r.name, k) + '.jpg';
    fs.writeFileSync(path.join(OUT, r.file), Buffer.from(f.data, 'base64'));
  });
}

const manifest = { provenance: prov, steps: results, problems: failed,
                   ...(video ? { video, duration: recEnd } : {}) };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'index.html'), page(manifest));

// The path, then the summary — the same order fleet-look prints in, and for the same
// reason: the path is what the next action needs.
console.log(path.join(OUT, 'index.html'));
console.log(`fleet-shots: ${results.length} step${results.length === 1 ? '' : 's'}` +
  (video ? `, one video (${recEnd.toFixed(1)}s, ${results.length} chapters)` : '') +
  `, ${results.reduce((a, r) => a + r.requests.length, 0)} requests` +
  (failed ? `, ${failed} STEP${failed === 1 ? '' : 'S'} WITH SOMETHING TO LOOK AT` : '') +
  (prov.commit ? ` · ${prov.commit.slice(0, 8)}${prov.dirty ? '+dirty' : ''}` : ''));
if (failed) console.log('fleet-shots: a step with a note is NOT a pass — open the page and read it');

// ── the index: every run, and who is working ────────────────────────────────
// WHAT THIS SCREEN IS FOR is deciding what to open, so the only thing that earns the top
// of a row is its STATE. A list of timestamps is a directory listing; the useful question
// is "which of these is waiting on me", so unreviewed and problem sort visually first and
// a fully-approved run is deliberately quiet.
function index(runs, sess, root) {
  const rows = runs.map(r => {
    const p = r.m.provenance || {};
    const st = { c: r.st.cls, t: r.st.text };
    return `<tr>
      <td class="st ${st.c}">${esc(st.t)}</td>
      <td><a href="/r/${encodeURIComponent(r.d)}/">${esc(p.branch || r.d)}</a></td>
      <td class="b mono">${p.commit ? esc(p.commit.slice(0, 8)) : ''}${p.dirty === true ? '+' : ''}</td>
      <td class="n mono">${isRecorded(r.m) ? `▶ ${r.m.steps.length}` : r.m.steps.length}</td>
      <td class="b mono">${esc(p.base || '')}</td>
      <td class="w mono">${esc(String(r.d).replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'))}</td>
    </tr>`;
  }).join('\n');
  const byProj = new Map();
  for (const x of sess) byProj.set(x.project, (byProj.get(x.project) || []).concat(x.name));
  const projs = [...byProj.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const who = sess.length
    ? `<span>${sess.length} sessions / ${projs.length} projects</span>`
      + projs.map(([n, l]) => `<span class="k">${esc(n)} ${l.length}</span>`).join('')
      + `<details><summary>names</summary>${projs.map(([n, l]) => `<div class="pr"><b>${esc(n)}</b> ${l.map(esc).join(' ')}</div>`).join('')}</details>`
    : '<span>no fleet sessions up</span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>reviews</title><style>${SKIN}</style></head><body>
<div class="bar"><span class="who">reviews</span><div class="facts">${esc(root)}</div></div>
<div class="wrap">${rows ? `<table class="runs"><thead><tr><th>state</th><th>branch</th><th>commit</th><th style="text-align:right">steps</th><th>base</th><th>when</th></tr></thead><tbody>${rows}</tbody></table>`
  : '<div class="empty">Nothing here yet.</div>'}</div>
<div class="foot">${who}</div>
</body></html>`;
}

// ── the review page ──────────────────────────────────────────────────────────
// Self-contained on purpose: no CDN, no fonts, no fetch. It has to open over file:// from
// a folder somebody synced, and every one of those would be a silent blank.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// ONE GENERATOR FOR BOTH SURFACES. The folder opens over file:// and the server serves the
// same page; two generators would drift, which is the same reason sessionStatuses is shared
// between the Projects cards and the stack screen — two readers of one truth disagreeing is
// the bug class this repo keeps paying for.
//   What differs is only the CHANNEL. Over file:// there is nowhere to POST, so verdicts go
// to localStorage and a button builds text to paste. Served, a click writes verdict.json
// directly and the gate sees it with no clipboard in the middle.
// ── the recorded-run page ────────────────────────────────────────────────────
// ONE FLOW, ONE VERDICT. The per-step page asked for a verdict on every still, which on a
// recording would be asking the reviewer to approve each chapter of one continuous thing —
// and the question they actually answer is "did the feature work, pressed end to end".
// So: the video, its chapters named by what each step asked for, a note per chapter where
// there is something to say, and approve or reject for the whole.
//   KEYS: space plays, ← → step chapters, a approves, r rejects — never while typing a note.
//   Same channels as the per-step page: served, a verdict writes verdict.json directly;
// over file:// it goes to localStorage and the text to paste is built below the bar.
// A DECLARATION, NOT A `const`: `serve` parks the module above this line, and a const down
// here would be in its dead zone for every page the server renders.
function fmtT(t) { t = Math.max(0, Math.floor(Number(t) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
function flowPage(m, served) {
  const p = m.provenance || {};
  const facts = [
    p.branch ? `<b>${esc(p.branch)}</b>` : null,
    p.commit ? esc(p.commit.slice(0, 8)) : null,
    p.dirty === true ? '<span class="flag">uncommitted</span>' : null,
    p.base ? esc(p.base) : null,
    `${p.viewport?.width}×${p.viewport?.height}`,
    p.at ? esc(p.at.replace('T', ' ').slice(0, 16)) : null,
  ].filter(Boolean).join(' · ');
  const MEANT = /^(Document|XHR|Fetch)$/i;
  const chapters = m.steps.map(s => {
    const calls = (s.requests || []).filter(r => MEANT.test(r.type || ''));
    const reqRows = calls.map(r => {
      const cls = r.failed || r.status >= 400 ? 'bad' : r.status >= 300 ? 'warn' : '';
      return `<tr class="${cls}"><td>${esc(r.method)}</td><td>${esc(r.failed || (r.status ?? '—'))}</td><td>${esc(r.url)}</td></tr>`;
    }).join('');
    const flagged = (s.notes || []).length > 0;
    return `<section class="ch${flagged ? ' flag' : ''}" data-n="${s.n}" data-start="${Number(s.start) || 0}" data-end="${Number(s.end) || 0}">
  <div class="top"><span class="n">${String(s.n).padStart(2, '0')}</span><span class="name">${esc(s.name)}</span><span class="at">${fmtT(s.start)}</span></div>
  <div class="where">${stepUrl(s) ? esc(stepUrl(s)) : 'no page'}${s.title ? ' · ' + esc(s.title) : ''}</div>
  ${s.expect ? `<div class="found${s.expect.found ? '' : ' miss'}">${s.expect.found ? 'found' : 'not found'} “${esc(s.expect.text)}”</div>` : ''}
  ${(s.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join('')}
  ${s.file ? `<a class="still" href="${esc(s.file)}" target="_blank"><img src="${esc(s.file)}" alt="${esc(s.name)} — the screen when it failed" loading="lazy"></a>` : ''}
  ${calls.length ? `<details${calls.some(r => r.failed || r.status >= 400) ? ' open' : ''}><summary>${calls.length} call${calls.length === 1 ? '' : 's'} of its own</summary><div class="reqs"><table>${reqRows}</table></div></details>` : ''}
  <textarea aria-label="note on chapter ${s.n}" placeholder="${flagged ? 'why is this acceptable? a note is what clears the flag' : 'note on this chapter (optional)'}"></textarea>
  ${flagged ? '<div class="needs" hidden>Approving does not clear this flag — one line saying why it is acceptable does.</div>' : ''}
</section>`;
  }).join('\n');
  const vtype = /\.webm$/.test(m.video) ? 'video/webm' : 'video/mp4';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${esc(p.branch || 'review')}</title><style>${FLOWSKIN}</style></head><body>
<div class="bar">
  <span class="who">review</span>
  <div class="facts">${facts}</div>
  <span class="chip none" id="state">not reviewed</span>
  ${served ? '<a class="up" href="/">all runs</a>' : ''}
</div>
<main>
  <div class="player">
    <div class="screen"><video id="v" preload="auto" playsinline muted><source src="${esc(m.video)}" type="${vtype}"></video></div>
    <div class="strip" id="strip"><span class="head" id="head"></span></div>
    <div class="transport">
      <button id="play" aria-label="play">▶ play</button>
      <span class="now" id="now"></span>
      <span class="t" id="time">0:00 / ${fmtT(m.duration)}</span>
    </div>
    <div class="keys"><b>space</b> play · <b>←</b> <b>→</b> chapters · <b>a</b> approve · <b>r</b> reject</div>
  </div>
  <div class="chapters" id="chapters">
    <h2>${m.steps.length} chapter${m.steps.length === 1 ? '' : 's'}${m.problems ? ` · <span style="color:var(--red)">${m.problems} to look at</span>` : ''}</h2>
    ${chapters}
  </div>
</main>
<div class="verdict">
  <div class="row">
    <input id="fnote" placeholder="a note on the whole flow (optional)" aria-label="note on the flow">
    <button class="danger" id="reject" data-v="reject">reject<kbd>r</kbd></button>
    <button class="go" id="approve" data-v="approve">approve<kbd>a</kbd></button>
    ${served ? '<span class="saved" id="saved"></span>' : ''}
  </div>
  <div class="gate" id="gate"></div>
  ${served ? '' : `<div class="paste">Paste it back so it counts: <code>pbpaste | fleet-shots verdict .</code> — then <code>fleet-shots --check .</code><textarea id="verdicttext" readonly></textarea></div>`}
</div>
<script>
var CH = ${JSON.stringify(m.steps.map(x => ({ n: x.n, name: x.name, start: Number(x.start) || 0, end: Number(x.end) || 0, flagged: (x.notes || []).length > 0 })))};
var DUR = ${JSON.stringify(Number(m.duration) || 0)};
var SERVED = ${served ? 'true' : 'false'};
var DIR = ${JSON.stringify(m.dir || '')};
var KEY = 'gf.flow.' + location.pathname;
var st = { flow: null, chapters: {} };
try { st = JSON.parse(localStorage.getItem(KEY) || 'null') || st; } catch (e) {}
// SERVED, THE FILE IS THE TRUTH: the page opens on what verdict.json holds, so a review
// started on the phone and finished at the desk is one review, not two browsers' guesses.
var INIT = ${JSON.stringify(m.verdict || null)};
if (SERVED && INIT) st = { flow: INIT.flow || null, chapters: INIT.chapters || {} };
st.chapters = st.chapters || {};
var v = document.getElementById('v');
var cards = document.querySelectorAll('.ch');
var cur = 0;

function dur(){ return (isFinite(v.duration) && v.duration > 0) ? v.duration : DUR; }
function save(){
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
  if (!SERVED) return;
  fetch('/api/verdict', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ dir: DIR, flow: st.flow, chapters: st.chapters }) })
    .then(function(r){ mark(r.ok); }).catch(function(){ mark(false); });
}
function mark(ok){ var e=document.getElementById('saved'); if(!e) return;
  e.textContent = ok ? 'saved' : 'NOT saved — the gate will not see this'; e.className = ok ? 'saved' : 'saved bad'; }
function noteOf(n){ return String(st.chapters[String(n)] || '').trim(); }
function chapterAt(t){ var k=0; for (var i=0;i<CH.length;i++) if (t + 0.05 >= CH[i].start) k=i; return k; }

// SEEK, THEN PAINT FROM WHAT THE VIDEO SAYS. A chapter click sets currentTime; the
// highlight follows timeupdate, so the list can never claim a chapter the picture is not on.
function go(i){
  i = Math.max(0, Math.min(CH.length-1, i));
  cur = i;
  try { v.currentTime = CH[i].start + 0.01; } catch (e) {}
  paint();
}
function paint(){
  cards.forEach(function(el,i){
    el.classList.toggle('here', i===cur);
    el.classList.toggle('has', !!noteOf(CH[i].n));
    var needs = el.querySelector('.needs'), ta = el.querySelector('textarea');
    var wants = CH[i].flagged && st.flow && st.flow.v==='approve' && !noteOf(CH[i].n);
    if (needs) needs.hidden = !wants;
    if (ta) ta.classList.toggle('wants', wants);
  });
  document.querySelectorAll('#strip button').forEach(function(b,i){ b.classList.toggle('here', i===cur); });
  document.getElementById('now').textContent = CH.length ? (CH[cur].n + '. ' + CH[cur].name) : '';
  document.getElementById('time').textContent = fmt(v.currentTime) + ' / ' + fmt(dur());
  document.getElementById('head').style.left = (dur() ? Math.min(100, 100 * v.currentTime / dur()) : 0) + '%';
  document.getElementById('play').textContent = v.paused ? '▶ play' : '❚❚ pause';
  var fv = st.flow && st.flow.v;
  document.getElementById('approve').classList.toggle('on', fv==='approve');
  document.getElementById('reject').classList.toggle('on', fv==='reject');
  gate();
}
function fmt(t){ t=Math.max(0,Math.floor(t||0)); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); }
function gate(){
  var fv = st.flow && st.flow.v, missing = CH.filter(function(c){ return c.flagged && !noteOf(c.n); });
  var g = document.getElementById('gate'), s = document.getElementById('state');
  if (fv==='reject') { g.className='gate rej'; g.textContent='rejected — fleet-shots --check refuses this run'; s.className='chip bad'; s.textContent='rejected'; }
  else if (!fv) { g.className='gate'; g.textContent='not reviewed yet — watch it, then approve or reject the flow'
      + (missing.length ? ' · ' + missing.length + ' chapter' + (missing.length===1?'':'s') + ' flagged by the run' : ''); s.className='chip none'; s.textContent='not reviewed'; }
  else if (missing.length) { g.className='gate fail'; g.textContent='approved, but --check still refuses: chapter '
      + missing.map(function(c){ return c.n; }).join(', ') + ' was flagged by the run and has no reason'; s.className='chip warn'; s.textContent='needs a reason'; }
  else { g.className='gate pass'; g.textContent='approved — fleet-shots --check passes this run'; s.className='chip ok'; s.textContent='approved'; }
  var t = document.getElementById('verdicttext');
  if (t) {
    var lines = [];
    lines.push(fv ? '- [' + fv + '] flow' + (st.flow.note ? ' — ' + st.flow.note : '') : '(the flow is not approved or rejected yet)');
    CH.forEach(function(c){ var n = noteOf(c.n); if (n) lines.push('- [note] ' + c.n + '. ' + c.name + ' — ' + n.replace(/\\n/g, ' ')); });
    t.value = lines.join('\\n');
  }
}
function choose(which){
  var note = document.getElementById('fnote').value;
  st.flow = { v: which, note: note };
  save(); paint();
  // approving over a flag with no reason: take the reader to where the reason goes
  if (which==='approve') {
    var i = CH.findIndex(function(c){ return c.flagged && !noteOf(c.n); });
    if (i >= 0) { go(i); var ta = cards[i].querySelector('textarea'); if (ta) ta.focus(); }
  }
}

// the strip: one segment per chapter, as wide as it plays
(function(){
  var strip = document.getElementById('strip'), total = dur() || 1;
  CH.forEach(function(c,i){
    var b = document.createElement('button');
    b.style.flex = String(Math.max(0.02, (c.end - c.start) / total));
    b.title = c.n + '. ' + c.name; b.setAttribute('aria-label', 'chapter ' + c.n + ': ' + c.name);
    if (c.flagged) b.classList.add('flag');
    b.addEventListener('click', function(){ go(i); });
    strip.insertBefore(b, document.getElementById('head'));
  });
})();
cards.forEach(function(el,i){
  el.querySelector('.top').addEventListener('click', function(){ go(i); });
  var ta = el.querySelector('textarea');
  ta.value = st.chapters[String(CH[i].n)] || '';
  ta.addEventListener('focus', function(){ if (cur !== i) { cur = i; paint(); } });
  ta.addEventListener('input', function(){
    if (ta.value.trim()) st.chapters[String(CH[i].n)] = ta.value; else delete st.chapters[String(CH[i].n)];
    save(); paint();
  });
});
document.getElementById('fnote').value = (st.flow && st.flow.note) || '';
document.getElementById('fnote').addEventListener('input', function(e){
  if (st.flow) { st.flow.note = e.target.value; save(); gate(); }
});
document.getElementById('approve').addEventListener('click', function(){ choose('approve'); });
document.getElementById('reject').addEventListener('click', function(){ choose('reject'); });
document.getElementById('play').addEventListener('click', function(){ v.paused ? v.play() : v.pause(); });
v.addEventListener('timeupdate', function(){ var k = chapterAt(v.currentTime); if (k !== cur) cur = k; paint(); });
v.addEventListener('play', paint); v.addEventListener('pause', paint); v.addEventListener('loadedmetadata', paint);
v.addEventListener('click', function(){ v.paused ? v.play() : v.pause(); });
// KEYS, and never while writing a note — a reviewer typing "a redirect" would otherwise
// approve the flow on the first letter.
document.addEventListener('keydown', function(e){
  var t = e.target.tagName;
  if (t==='TEXTAREA'||t==='INPUT'||e.metaKey||e.ctrlKey||e.altKey) return;
  if (e.key===' ') { v.paused ? v.play() : v.pause(); e.preventDefault(); }
  else if (e.key==='ArrowRight') { go(cur+1); e.preventDefault(); }
  else if (e.key==='ArrowLeft') { go(cur-1); e.preventDefault(); }
  else if (e.key==='a') { choose('approve'); e.preventDefault(); }
  else if (e.key==='r') { choose('reject'); e.preventDefault(); }
});
paint();
</script></body></html>`;
}

function page(m, served = false) {
  if (isRecorded(m)) return flowPage(m, served);
  const p = m.provenance || {};
  const facts = [
    p.branch ? `<b>${esc(p.branch)}</b>` : null,
    p.commit ? esc(p.commit.slice(0, 8)) : null,
    p.dirty === true ? '<span class="flag">uncommitted</span>' : null,
    p.base ? esc(p.base) : null,
    `${p.viewport?.width}×${p.viewport?.height}`,
    p.slot !== null && p.slot !== undefined ? `slot ${esc(p.slot)}` : null,
    p.at ? esc(p.at.replace('T', ' ').slice(0, 19)) : null,
  ].filter(Boolean).join('<span style="opacity:.4">·</span>');

  const steps = m.steps.map(s => {
    // WHAT THE PAGE ASKED FOR, SEPARATED FROM WHAT THE BUNDLER FETCHED. Measured on a real
    // Next app: step one made 36 requests and 34 of them were _next/static chunks, fonts
    // and CSS. The two that mattered were invisible in the scroll. A request log you skim
    // past is worth no more than no request log, and the whole reason this column exists is
    // that it catches what a screenshot cannot — so the calls go first, at full size, and
    // the assets collapse behind a count.
    //   Same partition the notes use (Document/XHR/Fetch), so the display and the flagging
    // cannot disagree about what counts as the app's own traffic.
    const MEANTR = /^(Document|XHR|Fetch)$/i;
    const row = (r) => {
      const cls = r.failed ? 'bad' : (r.status >= 400 ? 'bad' : (r.status >= 300 ? 'warn' : 'ok'));
      return `<tr class="${cls}"><td class="m">${esc(r.method)}</td><td class="s">${esc(r.failed ? r.failed : (r.status ?? '—'))}</td><td class="u">${esc(r.url)}</td></tr>`;
    };
    const calls = (s.requests || []).filter(r => MEANTR.test(r.type || ''));
    const assets = (s.requests || []).filter(r => !MEANTR.test(r.type || ''));
    const rows = calls.map(row).join('');
    // An asset that FAILED is still worth surfacing without being opened — a missing font
    // or a 404 chunk is a real defect, just not one the app asked for on purpose.
    const assetBad = assets.filter(r => r.failed || r.status >= 400).length;
    const assetBlock = assets.length
      ? `<details class="assets"${assetBad ? ' open' : ''}><summary>${assets.length} asset${assets.length === 1 ? '' : 's'}`
        + (assetBad ? ` · <span class="ab">${assetBad} failed</span>` : ' · all fine')
        + `</summary><div class="scroll"><table><tbody>${assets.map(row).join('')}</tbody></table></div></details>`
      : '';
    const lines = [];
    if (s.expect) lines.push(`<div class="${s.expect.found ? 'exp-ok' : 'exp-bad'}">${s.expect.found ? 'found' : 'not found'} “${esc(s.expect.text)}”`
      + (s.expect.how === 'case-insensitive' ? ` <span class="exp-note">— rendered in a different case (CSS text-transform)</span>` : '') + `</div>`);
    for (const n of (s.notes || [])) lines.push(`<div class="note">${esc(n)}</div>`);
    // COUNTED THE SAME WAY THE NOTES ARE. Counting every non-2xx here while the notes
    // deliberately ignore a sub-resource meant the caption said "1 failed" over a missing
    // favicon that nothing had flagged — two readers of one rule, disagreeing, which is
    // the bug class this repo keeps paying for. Only what the page asked for on purpose.
    const MEANT = /^(Document|XHR|Fetch)$/i;
    const bad = (s.requests || []).filter(r => MEANT.test(r.type || '') && (r.failed || r.status >= 400)).length;
    return `<section class="step" data-n="${s.n}">
  <div class="head">
    <span class="gut">${String(s.n).padStart(2, '0')}</span>
    <div><h2>${esc(s.name)}</h2><div class="sub">${stepUrl(s) ? esc(stepUrl(s)) : 'no page'}${s.title ? ' · ' + esc(s.title) : ''}</div></div>
  </div>
  ${lines.length ? `<div class="lines">${lines.join('')}</div>` : ''}
  <div class="body">
    <div class="mat">${s.file ? `<a href="${esc(s.file)}" target="_blank"><img src="${esc(s.file)}" alt="${esc(s.name)}" loading="lazy"></a>` : '<div class="none">no screenshot — the step threw</div>'}</div>
    <div class="calls">
      <div class="cap"><span>${calls.length} call${calls.length === 1 ? '' : 's'}</span>${bad ? `<span style="color:var(--bad);font-weight:600">${bad} failed</span>` : '<span>none failed</span>'}</div>
      ${calls.length ? `<div class="scroll"><table><thead><tr><th>method</th><th style="text-align:right;padding-right:10px">status</th><th>url</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="nocalls">no calls of its own</div>'}
      ${assetBlock}
      <textarea placeholder="${(s.notes || []).length ? 'why is this acceptable? a note is what clears the flag' : 'note'}"></textarea>
      ${(s.notes || []).length ? '<div class="needs" hidden>The run flagged this step. Approving does not clear it — write one line saying why it is acceptable, and <code>--check</code> will accept it with your reason on the record.</div>' : ''}
    </div>
  </div>
</section>`;
  }).join('\n');

  const flagged = m.problems || 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.branch || 'review')}</title><style>${SKIN}</style></head><body>
<div class="bar">
  <span class="who">review</span>
  <div class="facts">${facts}</div>
  <span class="pos" id="pos"></span>
  <div class="rail" id="rail"></div>
  <span class="count ${flagged ? '' : 'clear'}">${flagged ? flagged + ' to look at' : 'nothing flagged'}</span>
  ${served ? '<span class="state" id="saved">saved</span><a class="up" href="/">all runs</a>' : ''}
</div>
${steps}
<section class="done" id="done">
  <h2>All ${m.steps.length} step${m.steps.length === 1 ? '' : 's'} seen</h2>
  <div class="gate" id="gate"></div>
  <table id="summary"></table>
  <div class="how">Paste it back so it counts: <code>pbpaste | fleet-shots verdict .</code>
    — then <code>fleet-shots --check .</code> is what refuses to call this done.</div>
  <textarea id="verdicttext" readonly></textarea>
</section>
<div class="acts">
  <button class="nav" id="prev">← back</button>
  <div class="mid">
    <button class="v approve" data-v="ok">approve<kbd>a</kbd></button>
    <button class="v changes" data-v="problem">changes<kbd>c</kbd></button>
    <button class="v skip" data-v="skip">skip<kbd>s</kbd></button>
  </div>
  <button class="nav" id="next">next →</button>
</div>
<script>
// THE STEPPER. Every step is already in the page; this only decides which one is shown, so
// going back is instant and the images are already decoded. State is per-step and keyed on
// the folder, exactly as before — the change is to the pacing, not to what gets recorded.
var STEPS = ${JSON.stringify(m.steps.map(x => ({ n: x.n, name: x.name, notes: (x.notes || []).length })))};
var SERVED = ${served ? 'true' : 'false'};
var DIR = ${JSON.stringify(m.dir || '')};
var KEY = 'gf.shots.' + location.pathname;
var state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
var at = 0;                                  // 0..STEPS.length, the last index is the summary

function save(){
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  if (!SERVED) return;
  fetch('/api/verdict', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ dir: DIR, state: state }) })
    .then(function(r){ mark(r.ok ? 'saved' : 'failed'); }).catch(function(){ mark('failed'); });
}
function mark(w){ var e=document.getElementById('saved'); if(!e) return;
  e.textContent = w==='saved' ? 'saved' : 'NOT saved — the gate will not see this';
  e.className = w==='saved' ? 'state' : 'state bad'; }

function vOf(n){ return (state[String(n)]||{}).v || ''; }

// Shown the instant an approve/skip lands on a flagged step with no reason, and hidden
// again the moment one is typed — so the requirement appears where the decision is made
// rather than on a summary two screens later.
function needsPaint(i){
  var el=document.querySelectorAll('.step')[i]; if(!el) return;
  var box=el.querySelector('.needs'), ta=el.querySelector('textarea');
  if(!box||!ta) return;
  var st=STEPS[i], v=vOf(st.n), note=(state[String(st.n)]||{}).note||'';
  var wants = st.notes>0 && (v==='ok'||v==='skip') && !note.trim();
  box.hidden = !wants;
  ta.classList.toggle('wants', wants);
}
function paint(){
  var last = STEPS.length;
  document.querySelectorAll('.step').forEach(function(el,i){ el.classList.toggle('here', i===at); });
  document.getElementById('done').classList.toggle('here', at===last);
  document.getElementById('pos').textContent = at===last ? 'summary' : String(at+1)+' / '+last;
  document.getElementById('prev').disabled = at===0;
  document.getElementById('next').disabled = at===last;
  // the rail
  var rail=document.getElementById('rail'); rail.innerHTML='';
  STEPS.forEach(function(st,i){
    var b=document.createElement('button');
    b.title = st.n+'. '+st.name;
    var v=vOf(st.n); if(v) b.classList.add('v-'+v);
    if(i===at) b.classList.add('here');
    b.addEventListener('click', function(){ at=i; paint(); });
    rail.appendChild(b);
  });
  // the three verdict buttons reflect THIS step, and are meaningless on the summary
  var cur = at<last ? STEPS[at] : null;
  document.querySelectorAll('.acts .v').forEach(function(b){
    b.disabled = !cur;
    b.classList.toggle('on', !!cur && vOf(cur.n)===b.dataset.v);
  });
  if (at<last) needsPaint(at);
  if (at===last) summarise();
  window.scrollTo(0,0);
}

function choose(v){
  var last=STEPS.length; if(at>=last) return;
  var i0=at, st=STEPS[at], k=String(st.n);
  state[k]=state[k]||{};
  // SET, DO NOT TOGGLE. The toggle is left over from the checkbox list this replaced, and in
  // a stepper it is wrong: pressing approve on a step you already approved UNSET it and then
  // refused to advance, so the button appeared dead on exactly the second press. Found by
  // driving it rather than reading it. Changing your mind is picking a different verdict.
  state[k].v = v;
  save();
  // APPROVE AND SKIP MOVE ON; CHANGES DOES NOT. A step you are rejecting is the one place a
  // note is worth writing, and the note is also what clears a flag the run raised — so
  // advancing off it would be taking away the pen at the moment you need it.
  if (state[k].v==='problem') {
    paint();
    var ta=document.querySelectorAll('.step')[at].querySelector('textarea');
    if (ta) ta.focus();
    return;
  }
  // A FLAGGED STEP APPROVED WITHOUT A REASON DOES NOT ADVANCE either. Moving on would put
  // the requirement behind you at the exact moment it applied, which is how the first
  // version let somebody mark all five and only learn at the index that nothing cleared.
  if (state[k].v && !(st.notes>0 && !(state[k].note||'').trim())) at=Math.min(at+1,last);
  paint();
  if (at===i0) { var ta2=document.querySelectorAll('.step')[at].querySelector('textarea'); if(ta2) ta2.focus(); }
}

function summarise(){
  var rows='', pending=0, problems=0, flagged=0, lines=[];
  STEPS.forEach(function(st){
    var v=vOf(st.n), note=(state[String(st.n)]||{}).note||'';
    if(!v) pending++; if(v==='problem') problems++;
    // a run-raised note still counts unless the reviewer left a reason
    if(st.notes && !((v==='ok'||v==='skip') && note.trim())) flagged++;
    rows += '<tr><td class="v '+(v||'none')+'">'+(v||'—')+'</td><td>'+st.n+'. '+st.name
         +(note?' <span style="color:var(--dim)">— '+note.replace(/</g,'&lt;')+'</span>':'')+'</td></tr>';
    if(v||note) lines.push('- ['+(v||'unmarked')+'] '+st.n+'. '+st.name+(note?' — '+note:''));
  });
  document.getElementById('summary').innerHTML=rows;
  var g=document.getElementById('gate'), bad=pending||problems||flagged;
  g.className='gate '+(bad?'fail':'pass');
  g.textContent = bad
    ? 'fleet-shots --check would REFUSE this: '+pending+' unreviewed, '+problems+' needing changes, '+flagged+' flagged by the run itself'
    : 'fleet-shots --check would pass this';
  document.getElementById('verdicttext').value =
    (lines.length?lines:['(nothing marked)']).join('\\n');
}

document.getElementById('prev').addEventListener('click',function(){ at=Math.max(0,at-1); paint(); });
document.getElementById('next').addEventListener('click',function(){ at=Math.min(STEPS.length,at+1); paint(); });
document.querySelectorAll('.acts .v').forEach(function(b){
  b.addEventListener('click', function(){ choose(b.dataset.v); });
});
document.querySelectorAll('.step').forEach(function(el,i){
  var ta=el.querySelector('textarea'); if(!ta) return;
  ta.addEventListener('input', function(){
    var k=String(STEPS[i].n); state[k]=state[k]||{}; state[k].note=ta.value; save(); needsPaint(i);
  });
  var k=String(STEPS[i].n); if((state[k]||{}).note) ta.value=state[k].note;
});
// KEYS, and they must not fire while you are writing the note — a reviewer typing
// "cannot see the row" would otherwise approve, skip and advance mid-sentence.
document.addEventListener('keydown', function(e){
  var t=e.target.tagName;
  if (t==='TEXTAREA'||t==='INPUT'||e.metaKey||e.ctrlKey||e.altKey) return;
  if (e.key==='a') { choose('ok'); e.preventDefault(); }
  else if (e.key==='c') { choose('problem'); e.preventDefault(); }
  else if (e.key==='s') { choose('skip'); e.preventDefault(); }
  else if (e.key==='ArrowRight'||e.key==='j') { at=Math.min(STEPS.length,at+1); paint(); e.preventDefault(); }
  else if (e.key==='ArrowLeft'||e.key==='k') { at=Math.max(0,at-1); paint(); e.preventDefault(); }
});
paint();
</script></body></html>`;
}
