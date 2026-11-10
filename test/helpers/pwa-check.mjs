#!/usr/bin/env node
// test/helpers/pwa-check.mjs — the phone client's structural promises.
//
//     node test/helpers/pwa-check.mjs        # one "name <US> want <US> got" row per check
//
// phone-check.mjs drives the app in a real browser. This file proves the things that make it a
// shippable PWA rather than a page that happens to render, and every check here is a failure
// that is invisible until someone is standing outside with a phone:
//
//   - a CDN link or a bare import specifier: works on this laptop, dead on the tailnet (§5 — the
//     Mac has no route to the internet on the phone's behalf)
//   - a file added and not precached: the app installs, and then shows a blank screen the first
//     time it is opened offline
//   - an icon whose real pixels do not match its declared size: iOS silently falls back to a
//     screenshot of the page
//   - a status vocabulary that quietly collapses two values into one label
//
// SINCE v104 THE PHONE IS web/ui's APP (web/src/phone.jsx, built to phone.js and phone.css), the
// same screens the team app draws. The rows that pinned the old client's own code went with it,
// and each group's coverage is accounted for rather than dropped in silence:
//   - app.css's layout (the shell rule, the card snap, the session bar, the speaker icon, the
//     nav slide, skeleton cards, the thinking dots): that stylesheet is gone. What it protected
//     that still applies is asserted against phone.css below (the keyboard geometry, the bottom
//     inset, the status bar), and measured in a real engine by phone-check.mjs (no sideways
//     scroll at 390 and 320, every screen drawn, no native <select>, the composer keeps its
//     focus across a poll).
//   - the TUI's confirmation words reproduced in app.js (§7's "y = yes · any other key"): the
//     phone confirms with web/ui's dialogs now, as the team app does, and stopping with the
//     worktree removed asks for the session's NAME typed back, which is stronger than a `y`.
//     Asserted below as web/ui's own rules, and the server's refusal of the lead beside them.
//   - app.js's scroll memory, back-gesture plumbing, timers-versus-keyboard rule and speech:
//     web/ui's own (history.js, back.jsx), and a Preact re-render keeps the focused node, which
//     phone-check.mjs measures rather than this file asserting.
//   - the chrome pinned against Dynamic Type: web/ui sets its text in px throughout, so the
//     reader's text size does not reach the controls at all.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const read = f => fs.readFileSync(path.join(WEB, f), 'utf8');
const exists = f => fs.existsSync(path.join(WEB, f));
// A source that is missing reads as '' so the row that names it goes red, rather than this file
// throwing and emitting no rows at all (test/run.sh puts a floor under the count for that case).
const readOr = f => (exists(f) ? read(f) : '');
const noComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Imported HERE, at the top, not beside the section that first uses them. The first cut of this
// file put an `await import` below a section that used it: a temporal-dead-zone ReferenceError,
// ZERO rows emitted, and a bare "no mismatches" check called that green.
const G = await import(new URL('../../web/grid.js', import.meta.url).href);
const api = await import(new URL('../../web/api.js', import.meta.url).href);

const HTML = read('index.html');
const CSS = readOr('phone.css');
const FONTS = readOr('fonts/fonts.css');
// EVERY .js THE BROWSER LOADS, built or written. phone.js is vite's output for the whole app and
// preact.js the dependency chunk beside it; every rule below is about what the PHONE fetches, not
// about what a human typed. Spelled out rather than globbed, for the reason the SHELL list is: a
// new file in web/ should have to be thought about once, here.
// term.js is the terminal screen (imported lazily), and xterm.js / xterm-fit.js are what it
// drives — vendored from npm and pinned by digest (scripts/vendor-xterm.sh --check).
const JS_FILES = ['phone.js', 'preact.js', 'api.js', 'grid.js', 'passkey.js', 'ansi.js', 'md.js', 'sw.js', 'term.js', 'xterm.js', 'xterm-fit.js'];
const JS = Object.fromEntries(JS_FILES.map(f => [f, readOr(f)]));
// The sources the bundle is built from, for the rules that are about what a person wrote.
const SRC = {
  phone: readOr('src/phone.jsx'), adapter: readOr('src/adapter.js'), push: readOr('src/push.js'),
  lock: readOr('src/lock.jsx'), viewport: readOr('ui/viewport.js'), session: readOr('ui/session.jsx'),
  project: readOr('ui/project.jsx'), en: readOr('ui/words/en.js'),
};

// ── 1. nothing loads from off this machine ────────────────────────────────
// Checked as REFERENCES rather than by grepping for "http", so a URL inside a comment does not
// read as a dependency.
const htmlRefs = [...HTML.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1]);
is('index.html loads nothing remote', '', htmlRefs.filter(u => /^[a-z]+:\/\//i.test(u)).join(','));
is('index.html has no protocol-relative ref', '', htmlRefs.filter(u => u.startsWith('//')).join(','));
is('every local file index.html asks for exists', '',
   htmlRefs.filter(u => !/^[a-z]+:/i.test(u) && !exists(u.replace(/^\.\//, ''))).join(','));
const cssUrls = (src) => [...src.matchAll(/url\(\s*['"]?([^'")]+)/g)].map(m => m[1]);
is('the stylesheets pull in no font or image host', '',
   [...cssUrls(CSS), ...cssUrls(FONTS)].filter(u => /^[a-z]+:\/\//i.test(u) || u.startsWith('//')).join(','));
// The faces are vendored (web/fonts) so an installed app opened offline can still draw its own
// name; a font that is linked and not there falls back to the system face without a word.
is('every font the faces file names is there', '',
   cssUrls(FONTS).filter(u => !/^data:/.test(u) && !exists(path.join('fonts', u.replace(/^\.\//, '')))).join(','));
is('...and the faces file is linked', true, htmlRefs.includes('./fonts/fonts.css'));
// Bare specifiers need a bundler or an import map at RUN time; the bundle is built ahead, and a
// bare specifier left in its output is a dependency vite failed to resolve.
const specs = [];
for (const [f, src] of Object.entries(JS)) {
  for (const m of src.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) specs.push([f, m[1]]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) specs.push([f, m[1]]);
}
is('every import is a relative path', '',
   specs.filter(([, s]) => !s.startsWith('./') && !s.startsWith('../')).map(([f, s]) => `${f}:${s}`).join(','));
is('every imported module exists', '',
   specs.filter(([, s]) => !exists(s.replace(/^\.\//, ''))).map(([f, s]) => `${f}:${s}`).join(','));
// ONE file talks to the network — api.js — and the invariant is worth an assertion because
// breaking it is so natural: a screen that fetches its own thing works perfectly against fixtures
// and then reaches for a URL api.js knows how to resolve and it does not. The phone's adapter
// (web/src/adapter.js) is the seam: every web/ui screen asks it, and it asks api.js. (sw.js is
// exempt: intercepting fetch is what a service worker IS.)
for (const f of ['phone.js', 'grid.js', 'passkey.js', 'ansi.js', 'md.js']) {
  is(`${f} does not fetch directly`, 0, (JS[f].match(/\bfetch\(/g) || []).length);
}
is('api.js is the file that does', true, (JS['api.js'].match(/\bfetch\(/g) || []).length > 0);

// ── 1b. the build, and the ways a build step rots a client ────────────────
// The honesty of the output itself — that it was rebuilt from the source beside it — needs vite,
// so test/run.sh rebuilds and compares separately and SKIPS with a reason where it is absent.
is('the app ships its source', true, exists('src/phone.jsx'));
// THE OUTPUT IS STILL READABLE, which is the one thing a build step takes away and the reason
// this one is configured not to. Every phone-only bug in this repo was found by opening the file
// the device fetched and reading it. Asserted on names the SOURCE defines, so it cannot pass by
// matching preact's own code — and naming the screens is what catches a build that emitted only
// part of the app: `✓ built in 13ms` over 14.8 kB of preact and no screen is a measured failure
// this repo carries a scar for.
is('the bundle keeps its names', '',
   ['Root', 'Phone', 'Lock', 'Gate', 'FleetApp', 'Frame', 'Sidebar', 'Home', 'ProjectView', 'SessionView',
    'Settings', 'Assistant', 'phoneAdapter', 'syncViewport']
     .filter(n => !new RegExp(`function ${n}\\(`).test(JS['phone.js'])).join(','));
// ...AND THE CLIENT'S OWN MODULES ARE IMPORTED, NOT COPIED. api.js holds the one token and the
// one fetch; passkey.js the one ceremony in flight. A second copy inlined into the bundle is two
// tokens and two ceremonies, and the build exits 0 either way (vite.config.mjs marks them
// external; this is the assertion that the marking still takes).
is('the bundle imports api.js rather than copying it', true,
   /from\s*['"]\.\/api\.js['"]/.test(JS['phone.js']) && !/class AuthError\b/.test(JS['phone.js']));
is('...and passkey.js likewise', true,
   /from\s*['"]\.\/passkey\.js['"]/.test(JS['phone.js']) && !/function autoUnlock\(/.test(JS['phone.js']));
// The terminal is xterm and a few hundred kB: fetched when one is opened, never on every launch.
is('the terminal is loaded only when it is opened', true,
   /import\(\s*['"]\.\/term\.js['"]\s*\)/.test(JS['phone.js']) && !/from\s*['"]\.\/term\.js['"]/.test(JS['phone.js']));
// THE TEAM'S PARTS STAY OFF THE PHONE (users, roles, owners, the company AI account, usage caps,
// admin): one base is web/ui, and the phone bundles web/ and nothing of ee/. vite marks every
// module it inlines with a `//#region <path>` line, so this reads what was actually bundled (its
// own preload helper, for the lazy terminal, is named `\0vite/…`).
const regions = [...JS['phone.js'].matchAll(/^\/\/#region (\S+)/gm)].map(m => m[1]);
is('the bundle says what it is made of', true, regions.length > 10);
// lib/ is the daemon's own code (the phone's automations are edited against lib/automations-model.mjs,
// the shapes fleet-serve validates with), MIT core like web/; ee/ is what may never appear.
is('...and none of it is the team app', '', regions.filter(r => !/^(web\/|lib\/|node_modules\/|\\0vite\/)/.test(r)).join(','));

// ── 2. installable, and offline-usable ────────────────────────────────────
const man = JSON.parse(read('manifest.webmanifest'));
for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color']) {
  is(`manifest has ${k}`, true, man[k] != null);
}
is('manifest display is standalone', 'standalone', man.display);
is('rotation is not pinned to portrait', true, man.orientation !== 'portrait');
// The PNG's real pixels, out of its IHDR — a resized icon that kept its old filename is
// otherwise undetectable, and iOS answers it by ignoring the icon entirely.
function pngSize(rel) {
  const b = fs.readFileSync(path.join(WEB, rel));
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'not a png';
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}
for (const ic of man.icons) {
  const rel = ic.src.replace(/^\.\//, '');
  is(`icon ${ic.src} exists`, true, exists(rel));
  if (exists(rel)) is(`icon ${ic.src} really is ${ic.sizes}`, ic.sizes, pngSize(rel));
}
is('an apple-touch-icon is linked', true, /rel="apple-touch-icon"/.test(HTML));
is('...and it is 180x180', '180x180', exists('icons/apple-touch-icon.png') ? pngSize('icons/apple-touch-icon.png') : 'missing');

// ── the attachment limit is stated twice and must be one number ───────────
// The server's copy is the control (an upload past it is refused there whatever the client did);
// the client's is a courtesy that saves a phone from spending five megabytes over a tunnel to be
// told the number. They are only useful together if they AGREE.
{
  const serveSrc = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'utf8');
  const attachSrc = fs.readFileSync(path.join(ROOT, 'lib', 'attach.mjs'), 'utf8');
  const nOf = (src, name) => (new RegExp(`${name} = ([0-9*\\s]+);`).exec(src) || [])[1];
  const ev = (x) => { try { return x ? Function(`return (${x})`)() : null; } catch { return null; } };
  const server = ev(nOf(attachSrc, 'ATTACH_MAX_BYTES'));
  const client = ev(nOf(JS['api.js'], 'ATTACH_MAX_BYTES'));
  is('the photo limit is a real number on the server', true, server > 0);
  is('...and the client refuses at exactly the same one', server, client);
  // ...and the body cap has to leave room for base64, or the decoded check is unreachable.
  const cap = ev(nOf(serveSrc, 'ATTACH_BODY_CAP'));
  is('the body cap leaves room for base64', true, cap > server * 4 / 3);
}

// ── the keyboard, whose effect no desktop engine can show ─────────────────
// Measured on an iOS 26.5 simulator in the installed app: a page laid out to the full height
// stayed 844 tall while the visual viewport went to 431 with the keyboard up, so the document
// overflowed by the keyboard and iOS scrolled it 413 — the header went to y=-405. web/ui sizes
// the app `height: 100%`, which iOS does not shrink for a keyboard either, so the fix moved with
// the screens: web/ui/viewport.js pins the app to the visual viewport WHILE THE KEYBOARD IS UP,
// and only then (the history of this fix, and why each half is shaped as it is, is in that
// file). Pinned here because headless Chrome has no on-screen keyboard; phone-check.mjs drives
// the JS half against a shrunken visual viewport.
const VP = noComments(SRC.viewport);
is('the app takes its keyboard-up geometry from custom properties', true,
   /html\.kb #app\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*var\(--app-top, 0px\) 0 auto;[^}]*height:\s*var\(--app-h, 100%\)/.test(CSS));
is('...which viewport.js writes from the visual viewport', true,
   /setProperty\('--app-h', Math\.round\(h\) \+ 'px'\)/.test(VP) && /setProperty\('--app-top'/.test(VP));
// REMOVED, NOT EMPTIED: setProperty(name, '') does not reliably remove a custom property in
// WebKit, and a fallback is reached only when the property is ABSENT.
is('...and REMOVES when the keyboard goes, so the closed layout is the plain one', true,
   /removeProperty\('--app-h'\)/.test(VP) && /removeProperty\('--app-top'\)/.test(VP) && /classList\.remove\('kb'\)/.test(VP));
is('...and never empties one instead', false, /setProperty\('--app-(h|top)',\s*''\)/.test(VP));
is('...following the visual viewport\'s resize and its scroll', true,
   /visualViewport\?\.addEventListener\('resize', syncViewport\)/.test(VP) && /visualViewport\?\.addEventListener\('scroll', syncViewport\)/.test(VP));
// The version before the one that worked called scrollTo(0,0) on every visualViewport scroll,
// which fights the reader and the browser for the same scrollbar.
is('...and never scrolls the window itself', false, /\b(window\.)?scroll(To|By)\(|\bwindow\.scroll\(/.test(VP));
is('...and both apps load it', true, /import '\.\/viewport\.js'/.test(readOr('ui/app.jsx')));
is('...and the shared ⏎ rule takes its answer', true, /setSoftKeyboardProbe\(/.test(VP));
is('...and the old --vvh is not coming back', false, /--vvh/.test(CSS) || /--vvh/.test(VP));
// NOT position: fixed on the composer. It is the obvious reach for "pin this to the bottom" and
// the thing that fights iOS keyboards hardest; the composer is the last child of a column whose
// height is right, which needs no pinning.
is('the composer is not pinned with position: fixed', false, /\.composer\s*\{[^}]*position:\s*fixed/.test(noComments(CSS)));

// ── the bottom inset is read ONCE ─────────────────────────────────────────
// Reported, on the old client, as a band of unused space above the bottom of the screen: a child
// added env(safe-area-inset-bottom) again inside a parent that already stopped that far up, and
// spent it twice. env() is 0 in every desktop engine and in headless Chrome, so the bug and the
// fix render pixel-identical to every instrument this suite has. So the inset is READ once, into
// --safe-b (web/ui/ui.css), and everything that owes it takes the variable; a second env() is
// somebody paying it a second way.
is('the bottom inset is read in one place', 1,
   (noComments(CSS).match(/env\(safe-area-inset-bottom/g) || []).length);
is('...into --safe-b', true, /--safe-b:\s*env\(safe-area-inset-bottom/.test(CSS));
// The bottom inset is for the home indicator; the keyboard covers the home indicator; so while it
// is up the inset is dead space stacked on the keyboard — "you are leaving too much space between
// the text box and the bottom".
is('...which goes to 0 while the keyboard is up', true, /html\.kb\s*\{[^}]*--safe-b:\s*0px/.test(CSS));
is('...and the composer takes it from there', true, /\.composer\s*\{[^}]*padding-bottom:\s*calc\([^)]*var\(--safe-b\)/.test(CSS));

// ── the status bar is OPAQUE, because a translucent one costs the bottom of the screen ──
// Four launches measured it: in iOS 26 standalone with `black-translucent`, WebKit positions the
// web view at the top of the screen (under the status bar) but sizes it to the screen minus the
// status bar — so the bottom strip belongs to no page and no CSS reaches it. WebKit bug 301108;
// Apple's own meta-tag doc says `default` or `black` puts the content below the status bar and
// hands the page a web view that runs to the real bottom. `black` rather than `default`: the app
// is dark in every theme and a default bar can come back white.
//   PINNED HERE BECAUSE NO ENGINE IN THIS SUITE CAN SEE IT.
const sbStyle = (/<meta name="apple-mobile-web-app-status-bar-style" content="([^"]*)"/.exec(HTML) || [, ''])[1];
is('the status bar is opaque, not translucent', 'black', sbStyle);
// viewport-fit=cover is NOT the broken half, and it is still what puts the page under the home
// indicator at the bottom. Dropping it would inset the layout and put the band back.
is('...and the page still claims the bottom edge', true, /viewport-fit=cover/.test(HTML));
// Paying the status bar back into a height extended the LAYOUT past a web view that ends where it
// ends, which is how a composer came to be cut off.
is('...and no rule pays the status bar back into a height', 0,
   (noComments(CSS).match(/height:\s*calc\([^;]*env\(safe-area-inset-top\)/g) || []).length);
// Standalone is still marked from either signal: iOS has honoured navigator.standalone since
// before the media query existed, and the two have not always agreed.
is('the client marks standalone', true, /classList\.toggle\('standalone'/.test(SRC.phone));
is('...from the media query and navigator.standalone', true,
   /display-mode: standalone/.test(SRC.push) && /navigator\.standalone/.test(SRC.push));
is('...and again on rotation', true, /addEventListener\('orientationchange', markStandalone\)/.test(SRC.phone));

// ── the precache list, in BOTH directions ─────────────────────────────────
// A stale entry breaks nothing visibly; a MISSING entry breaks the app only offline, only on the
// first try, and only for whoever is standing on a train. Read from the array that IS the precache
// list: sw.js also holds './…' strings that are cache KEYS, not files ('./__push-key').
const SW = JS['sw.js'];
const shellBlock = (/const SHELL = \[([\s\S]*?)\n\];/.exec(SW) || [])[1] || '';
is('the precache list is where it says it is', true, !!shellBlock);
const shell = [...shellBlock.matchAll(/'(\.\/[^']*)'/g)].map(m => m[1].replace(/^\.\//, '')).filter(Boolean);
is('every precached file exists', '', shell.filter(f => f && !exists(f)).join(','));
const shipped = [
  'index.html', 'phone.css', 'xterm.css', ...JS_FILES.filter(f => f !== 'sw.js'), 'manifest.webmanifest',
  ...fs.readdirSync(path.join(WEB, 'icons')).filter(f => f.endsWith('.png')).map(f => `icons/${f}`),
  ...fs.readdirSync(path.join(WEB, 'fixtures')).filter(f => f.endsWith('.json')).map(f => `fixtures/${f}`),
  'fonts/fonts.css', ...fs.readdirSync(path.join(WEB, 'fonts')).filter(f => f.endsWith('.woff2')).map(f => `fonts/${f}`),
];
is('every shipped file is precached', '', shipped.filter(f => !shell.includes(f)).join(','));
// The old client's files are gone from web/, and a precache entry for one would fail the
// worker's install outright (cache.addAll is all or nothing).
is('the old client is not precached', '',
   shell.filter(f => ['app.js', 'app.css', 'screens.js', 'place.js', 'grid-search.js'].includes(f)).join(','));
is('the service worker never caches a verb', true, /req\.method !== 'GET'/.test(SW));

// ── push: a bell that always rings, and only from a home screen ─────────────
// Two iOS rules that are invisible until a phone is in someone's hand:
//   1. A push whose service worker does not call showNotification can have the SUBSCRIPTION
//      REVOKED. So the worker may not have an opinion about whether to bother anybody — every
//      suppression decision belongs on the server.
//   2. A Safari TAB cannot subscribe at all; only a home-screen install can. A button that opens
//      no prompt is indistinguishable from a broken one, so the app says which state it is in.
const pushHandler = (/addEventListener\('push',[\s\S]*?\n\}\);/.exec(SW) || [''])[0];
is('the worker handles a push', true, !!pushHandler);
is('...and always shows a notification', true, /showNotification\(/.test(pushHandler));
is('...with no path that shows nothing', false, /\breturn\b/.test(pushHandler));
is('...even for an unreadable payload', true, /catch\s*{\s*d = null;?\s*}/.test(SW) && /pushText\(d \|\| \{\}\)/.test(SW));
is('a tap on it opens the app', true, /addEventListener\('notificationclick'/.test(SW));
is('a rotated subscription is handled', true, /addEventListener\('pushsubscriptionchange'/.test(SW));
// THE NOTIFICATION'S WORDS ARE THE WORKER'S, NOT THE PAYLOAD'S.
is('the text is written here, not sent', false, /\bd\.(body|text|message|note|detail|title|prose)\b/.test(SW));
is('...from an enum of kinds', true, /kind === 'needs-you'/.test(SW));
// The client's own half of rule 2: detect it, and SAY it, in both languages' catalogs.
is('...and says what to do about a tab', true, /'push\.iosTab':[^\n]*Add to Home Screen/.test(SRC.en));
is('...and names a denied permission', true, /'push\.denied':[^\n]*iOS Settings/.test(SRC.en));
// Fixtures have no server to send a push, and a toggle that looked live against them would be
// the same lie api.js's three-way connection picker exists to stop.
is('...and refuses to pretend in fixtures', true, /api\.mode\(\) !== 'server'\) return tr\('push\.fixtures'\)/.test(SRC.push));
is('the subscription is uploaded with the token', true, /pushSubscribe\(/.test(JS['api.js']) && /pushSubscribe\(/.test(SRC.push));
// ...and a tapped notification lands where its content is, AFTER the unlock: the old screens'
// names (#jarvis, #waiting) are mapped onto the pages that hold their content now.
is('a notification opens the assistant or the queue', true,
   /'#jarvis': '\/'/.test(SRC.phone) && /'#waiting': '\/queue'/.test(SRC.phone) && /open === 'waiting' \? '\/queue'/.test(SRC.phone));

// THE WORDING IS THE PRODUCT, so it is RENDERED here rather than pattern-matched. sw.js cannot be
// imported — its top-level `self.addEventListener` throws outside a worker — so the one pure
// function in it is lifted out and called.
const pushTextSrc = (/function pushText\(d\) \{[\s\S]*?\n\}/.exec(SW) || [''])[0];
let pushTextFn = null;
try { pushTextFn = eval(`(${pushTextSrc})`); } catch {}
is('the notification wording is testable', 'function', typeof pushTextFn);
if (typeof pushTextFn === 'function') {
  const say = (d) => { const t = pushTextFn(d); return `${t.title} | ${t.body}`; };
  is('one named session reads as itself', 'api-2 needs you | acme-api',
     say({ v: 1, kind: 'needs-you', n: 1, sessions: [{ project: 'acme-api', session: 'api-2', kind: 'needs-you' }] }));
  is('an answer says so', 'master has an answer | acme-api',
     say({ v: 1, kind: 'answer', n: 1, sessions: [{ project: 'acme-api', session: 'master', kind: 'answer' }] }));
  is('a burst says how many', '3 sessions have answers | acme-api/api-2 · web/master',
     say({ v: 1, kind: 'answer', n: 3, sessions: [{ project: 'acme-api', session: 'api-2', kind: 'answer' }, { project: 'web', session: 'master', kind: 'answer' }] }));
  is('anonymous never says "1 sessions"', 'a session needs you | open ghostfleet to see which',
     say({ v: 1, kind: 'needs-you', n: 1 }));
  is('...and names nothing at all', '4 sessions have answers | open ghostfleet to see which',
     say({ v: 1, kind: 'answer', n: 4 }));
  is('an unreadable payload invents nothing', 'ghostfleet | something needs you — open to see which', say({}));
}

// A CACHE VERSION THAT DID NOT MOVE IS A DEPLOY THAT DID NOT LAND. The shell is served
// CACHE-FIRST: a phone that already has the old version paints the old bundle on the first open
// after a deploy and revalidates behind it, which is indistinguishable from the fix not working.
// So the version is pinned to the client's own bytes: change any precached file and this goes red
// with the hash to paste, and the moment you paste it is the moment you bump VERSION. Everything
// precached from web/ counts EXCEPT sw.js itself, which contains the pin.
const pinned = shell.filter(f => f !== 'sw.js' && exists(f)).sort();
const clientHash = crypto.createHash('sha256')
  .update(pinned.map(f => f + '\0' + fs.readFileSync(path.join(WEB, f))).join('\0'))
  .digest('hex').slice(0, 12);
const recorded = (/CLIENT-HASH:\s*([0-9a-f]{12})/.exec(SW) || [])[1] || '(none recorded)';
is('the cache version is pinned to the client', clientHash, recorded);
is('...install fills the new cache', true, /caches\.open\(VERSION\)/.test(SW));
is('...and activate drops the old ones', true, /if \(k !== VERSION\) await caches\.delete\(k\)/.test(SW));

// A CACHE-FIRST SHELL DOES NOT REACH A PHONE BY ITSELF. Bumping VERSION lands the new bytes; it
// does not re-parse a page that is already open. Both halves have to be present for one open to
// be enough: the worker CLAIMS the page, and the page reloads when it does — never mid-sentence,
// because a draft lives in memory. A reload keeps the page process, and with it the session
// token (sessionStorage), so a swap costs no Face ID: passkey.js resume() takes it back first.
is('the worker answers which version it is', true,
   /type === 'version'[\s\S]{0,160}postMessage\(\{ version: VERSION \}\)/.test(SW));
is('...and the client asks it', true, /export (async )?function askShellVersion\(/.test(SRC.push) && /push\.askShellVersion\(\)/.test(SRC.phone));
is('the worker claims open pages', true, /clients\.claim\(\)/.test(SW));
is('...and the client reloads when it is claimed', true,
   /addEventListener\('controllerchange'[\s\S]{0,400}location\.reload\(\)/.test(SRC.phone));
is('...but not while something is being typed', true, /if \(typing\(\)\) \{ setTimeout\(swap, 5000\); return; \}/.test(SRC.phone));
is('...and the reloaded page takes its session back before it asks for a passkey', true,
   /pk\.resume\(\)\.then\(\(r\) => \{\s*if \(r === 'ok'\)/.test(SRC.phone));

// ── 3. the fixtures are §4, exactly ───────────────────────────────────────
const NINE = ['need-you', 'working', 'ready', 'parked', 'idle', 'starting', 'unknown', 'limit', 'interrupted'];
const TOP = ['project', 'profile', 'sub', 'counts', 'cards', 'free_worktrees'].sort().join(',');
const CARD = ['name', 'label', 'status', 'folder', 'branch', 'agent', 'pr', 'msg', 'age', 'attached', 'sched', 'limit_at', 'lead', 'exited', 'parent', 'workers', 'team_status', 'sub_head'].sort().join(',');
const COUNTS = ['need_you', 'working', 'ready', 'parked', 'limit', 'interrupted'].sort().join(',');
const fixDir = path.join(WEB, 'fixtures');
const grids = fs.readdirSync(fixDir).filter(f => /^grid-.*\.json$/.test(f)).sort();
for (const f of grids) {
  const g = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
  is(`${f}: top-level keys are §4's`, TOP, Object.keys(g).sort().join(','));
  is(`${f}: counts keys are §4's`, COUNTS, Object.keys(g.counts).sort().join(','));
  (g.cards || []).forEach((c, i) => {
    is(`${f}#${i}: card keys are §4's`, CARD, Object.keys(c).sort().join(','));
    is(`${f}#${i}: status is one of the nine`, true, NINE.includes(c.status));
    // A BOOLEAN, never absent and never a string: the screens gate the destructive buttons on it,
    // and `undefined` is falsy in exactly the way a real `false` is.
    is(`${f}#${i}: lead is a boolean`, 'boolean', typeof c.lead);
  });
  const leads = (g.cards || []).filter(c => c.lead);
  is(`${f}: at most one lead`, true, leads.length <= 1);
  if (leads.length) is(`${f}: the lead is the first card`, true, g.cards[0].lead === true);
  (g.free_worktrees || []).forEach((w, i) => {
    is(`${f} free#${i}: keys are §4's`, 'branch,path,task', Object.keys(w).sort().join(','));
  });
}
const sessions = fs.readdirSync(fixDir).filter(f => /^session-/.test(f));
is('there is a session fixture longer than one page', true,
   sessions.some(f => (JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8')).messages || []).length > 20));

// ── an empty transcript is an empty state, not a CLI hint ──────────────────
// fleet-read answers a session that has not taken a turn with a note written for a terminal
// ("…Send it work: fleet-send -s …"). Printed verbatim, a phone user was told to run a shell
// command they have no shell for. The screen owes the reader a sentence.
is('an empty transcript says so in plain words', true, /t\('sess\.noMsgs'\)/.test(SRC.session));
is("...and never prints fleet-read's note", false, /\.note\b/.test(noComments(SRC.session)));

// ── the phone probes are gone, and stay gone ──────────────────────────────
is('the client sends no __diag beacon', false, /__diag/.test(JS['api.js'] + JS['phone.js']));

// ── 4. the guardrails, as web/ui draws them ───────────────────────────────
// The lead's card looks like a worker's, so the one thing standing between `master` and a stop on
// this screen is that the button is not drawn. Read off §4's `lead` flag, NEVER by comparing the
// name, and only once the card is THERE — a deep link draws the screen before the grid answers.
// None of this is the enforcement — mcp/fleet-dispatch.mjs refuses the call whoever asks,
// asserted last — it is what keeps a tap from being refused.
const sess = noComments(SRC.session);
is('the lead is not offered a stop', true, /\{card && !card\.lead \? <button onClick=\{\(\) => \{ setMenu\(false\); stop\(false\); \}\}/.test(sess));
is('...nor a stop that removes its checkout', true, /\{card && !card\.lead \? <button class="danger" onClick=\{\(\) => \{ setMenu\(false\); stop\(true\); \}\}/.test(sess));
is('...nor a rename', true, /\{card && !card\.lead \? <button onClick=\{\(\) => \{ setMenu\(false\); setRename\(name\); \}\}/.test(sess));
is('...nor a pause', true, /\{card && !card\.lead && !\['asleep', 'lost'\]\.includes\(st\)/.test(sess));
// A stop that also deletes the worktree asks for the session's name typed back: a reflex can
// answer "yes", it cannot type `api-fix`.
is('a stop that removes the checkout asks for the name typed', true, /typed: reclaim \? name : null/.test(sess));
is('...and is reachable', true, /act\('fleet_stop', reclaim \? \{ reclaim: true \} : \{\}/.test(sess));
is('removing a worktree is confirmed first', true, /act\('fleet_worktree_remove'[^\n]*\{ confirm: true \}/.test(SRC.project));
is('the server refuses the lead whoever asks', true,
   /refusing to \$\{why\} '\$\{LEAD\}'/.test(fs.readFileSync(path.join(ROOT, 'mcp', 'fleet-dispatch.mjs'), 'utf8')));
// Fixture mode holds the same line, so a demo cannot teach a tap the real server refuses.
is('fixture mode refuses to stop the lead', true, /refusing to stop 'master'/.test(JS['api.js']));
is('...and to rename it', true, /refusing to rename 'master'/.test(JS['api.js']));
is('...and to park it', true, /refusing to park 'master'/.test(JS['api.js']));

// ── 5. the passkey, and where it is enforced ──────────────────────────────
// fleet-serve's TOOLS_ALLOWED table IS the enforcement: a verb marked `passkey: true` is refused
// without a fresh assertion, whatever the client did. The phone's adapter asks the sensor before
// exactly those verbs — read out of both files, so a verb gated on one side and not the other is
// a red row here rather than a tap that is refused on the train, naming a passkey it never asked.
const SERVE = fs.readFileSync(path.join(ROOT, 'bin', 'fleet-serve.mjs'), 'utf8');
const toolsBlock = (/const TOOLS_ALLOWED = \{([\s\S]*?)\n\};/.exec(SERVE) || [])[1] || '';
const serverGated = [...toolsBlock.matchAll(/^\s*(fleet_\w+):\s*\{([^}]*)\}/gm)].filter(m => /passkey: true/.test(m[2])).map(m => m[1]).sort();
const phoneGated = ((/export const PASSKEY = new Set\(\[([^\]]*)\]\)/.exec(SRC.adapter) || [])[1] || '')
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
is('the server gates some verbs behind a passkey', true, serverGated.length >= 4);
is('the phone asks a passkey for exactly the verbs fleet-serve gates', serverGated.join(','), phoneGated.join(','));
is('api.js still names the core three', 'fleet_rename,fleet_spawn,fleet_stop', [...api.DESTRUCTIVE].sort().join(','));
// The card's label and its scheduled continue are the team server's own verbs. fleet-serve refuses
// both by name (NOT_YET), so the phone does not offer them. When the server learns them this goes
// red, and the fix is to delete NOT_SERVED in web/src/adapter.js and wire the verbs through.
const notYet = (/const NOT_YET = \{([\s\S]*?)\n\};/.exec(SERVE) || [])[1] || '';
is('label and schedule are hidden while fleet-serve refuses them', true,
   /^\s*fleet_label:/m.test(notYet) && /^\s*fleet_schedule:/m.test(notYet)
   && /NOT_SERVED = new Set\(\['gfw_label', 'gfw_schedule', 'gfw_unschedule'\]\)/.test(SRC.adapter));
is('...through the screen\'s own question', true, /can\('gfw_label'\)/.test(sess) && /can\('gfw_schedule'\)/.test(sess));
// The terminal and the editor open through one path, each with a fresh assertion of its own.
is('a terminal or an editor opens through the one path', true, /api\.termOpen\(project, size, a, kind\)/.test(SRC.adapter));
is('the client never builds a tab name itself', 0, (JS['phone.js'].match(/['"`]_(term|edit)-/g) || []).length);
is('the page bound is 20', 20, api.PAGE);

// ── 5b. nothing runs before its declarations exist ────────────────────────
// The bug this exists for: a boot block at the TOP of a file, above a `const` the first render
// draws, threw "Cannot access … before initialization" and every screen was blank — in a file
// that is valid syntax, so `node --check` passes it. For the hand-written modules the rule is
// structural: every top-level DECLARATION comes before the first top-level STATEMENT. (The bundle
// is ordered by vite, and phone-check.mjs runs it.)
for (const f of ['api.js', 'grid.js', 'passkey.js', 'ansi.js', 'md.js']) {
  const lines = JS[f].split('\n');
  let lastDecl = -1, firstStmt = Infinity;
  lines.forEach((l, i) => {
    if (/^(?:export\s+)?(?:const|let|var|function|class)\s/.test(l)) lastDecl = i;
    else if (/^(?:await\s|if\s*\(|for\s*\(|while\s*\(|[A-Za-z_$][\w$.]*\s*\()/.test(l)
             && !/^(?:import|export)\b/.test(l)) firstStmt = Math.min(firstStmt, i);
  });
  is(`${f}: nothing executes before the last declaration`, true, firstStmt > lastDecl);
}

// ── 5d. one cell per character, whatever the font does ────────────────────
// ⧗ measures 1.274 cells and ⏸ 1.046 in every monospace face on this machine, so a line of
// terminal output with one in it went a quarter of a column wide. The pane cannot pick a font
// that behaves, so it pins every non-ASCII code point to one CELL: cells() is the split, and
// web/ui's `.pane .c` the 1ch box it lands in.
is('the pane renders through cells()', true, /import \{ cells[^}]*\} from '\.\/grid\.js'/.test(JS['ansi.js']));
is('...into a 1ch box', true, /\.pane \.c\s*\{[^}]*width:\s*1ch/.test(CSS));
is('...and a 2ch box for a two-column cell', true, /\.pane \.c\.w\s*\{[^}]*width:\s*2ch/.test(CSS));
is('the pane never wraps', true, /\.pane\s*\{[^}]*white-space:\s*pre[;\s]/.test(noComments(CSS)));
is('the session screen draws the pane with it', true, /import \{ render as renderAnsi \} from '\.\.\/ansi\.js'/.test(SRC.session));
{
  let joined = 0, split = 0, notOne = 0, asciiLeak = 0, lines = 0;
  const nonAscii = s => [...s].filter(c => c.codePointAt(0) >= 0x80).length;
  // Real pane output, captured from live sessions: box drawing, CJK, emoji — exactly the input
  // the function exists for.
  const panes = fs.readdirSync(fixDir).filter(f => /^pane-.*\.json$/.test(f)).sort();
  is('there are pane fixtures to split', true, panes.length > 0);
  for (const f of panes) {
    const j = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
    const body = String(j.pane || '').replace(/\x1b\[[0-9;]*m/g, '');
    for (const line of body.split('\n')) {
      lines++;
      const toks = G.cells(line);
      if (toks.map(t => t.text).join('') !== line) joined++;
      if (toks.filter(t => t.cell).length !== nonAscii(line)) split++;
      if (toks.some(t => t.cell && [...t.text].length !== 1)) notOne++;
      if (toks.some(t => !t.cell && nonAscii(t.text) > 0)) asciiLeak++;
    }
  }
  is('there were pane lines to split', true, lines > 100);
  is('cells() loses no character', 0, joined);
  is('cells() boxes every non-ASCII code point', 0, split);
  is('...one code point per box', 0, notOne);
  is('...and leaves nothing non-ASCII outside a box', 0, asciiLeak);
}
for (const st of NINE) {
  const glyph = [...G.STATUS[st].label][0];
  const ascii = glyph.codePointAt(0) < 0x80;
  const boxed = G.cells(G.STATUS[st].label).some(t => t.cell && t.text === glyph);
  is(`the ${st} glyph occupies exactly one cell`, true, ascii || boxed);
}
is('the pane read goes through api.js', true, /export async function getPane/.test(JS['api.js']));
is('...and ansi.js fetches nothing', '', (JS['ansi.js'].match(/\bfetch\(/g) || []).join(','));

// ── 6. no status is quietly folded into another ────────────────────────────
is('nine statuses, nine distinct labels', 9, new Set(NINE.map(s => G.STATUS[s].label)).size);
is('unknown is not idle', true, G.STATUS.unknown.label !== G.STATUS.idle.label && G.STATUS.unknown.color !== G.STATUS.idle.color);
is('limit is not ready', true, G.STATUS.limit.label !== G.STATUS.ready.label && G.STATUS.limit.color !== G.STATUS.ready.color);
is('interrupted is not ready', true, G.STATUS.interrupted.label !== G.STATUS.ready.label && G.STATUS.interrupted.color !== G.STATUS.ready.color);
is('limit is counted apart from ready', '0 need you · 0 working · 0 ready · 5 at limit',
   G.countsLine({ need_you: 0, working: 0, ready: 0, limit: 5, interrupted: 0, parked: 0 }));
is('interrupted is counted apart from ready', '0 need you · 0 working · 0 ready · 3 interrupted',
   G.countsLine({ need_you: 0, working: 0, ready: 0, limit: 0, interrupted: 3, parked: 0 }));
is('a zero clause is not printed', '0 need you · 2 working · 4 ready',
   G.countsLine({ need_you: 0, working: 2, ready: 4, limit: 0, interrupted: 0, parked: 0 }));

// ── 7. the schedule clock ─────────────────────────────────────────────────
// parseWhen is mirrored from the TUI; the clock is pinned so the assertions cannot be flaky at a
// second boundary. 2026-08-21 09:00 local.
const NOW = Math.floor(new Date(2026, 7, 21, 9, 0, 0).getTime() / 1000);
const at = s => G.parseWhen(s, NOW);
is('+2h', NOW + 7200, at('+2h'));
is('+30m', NOW + 1800, at('+30m'));
is('15:30 today', Math.floor(new Date(2026, 7, 21, 15, 30, 0).getTime() / 1000), at('15:30'));
is('3:50am has passed, so tomorrow', Math.floor(new Date(2026, 7, 22, 3, 50, 0).getTime() / 1000), at('3:50am'));
is('a bare hour', Math.floor(new Date(2026, 7, 21, 11, 0, 0).getTime() / 1000), at('11'));
is('25:00 is not a time', null, at('25:00'));
is('nonsense is not a time', null, at('soon'));
is('empty is not a time', null, at(''));

// ── 8. the offline promise, and the token ─────────────────────────────────
// A server that stops answering leaves the fleet it last sent on screen, dated, across the top of
// every page: the question this app answers is "is anything blocked on me", and the answer from
// ten minutes ago with its age beside it is worth more than a blank page.
is('a fleet that stopped answering stays on screen, dated', true,
   /t\('phone\.offline', \{ ago: ago\(/.test(SRC.phone) && /banner: <Bar error=\{error\} okAt=/.test(SRC.phone));
// §5's rule about the token, checked as CODE and not as prose. It is kept for the life of the
// PAGE PROCESS: sessionStorage, which a kill from the iOS app switcher empties and the app's own
// reload keeps. ONE write, under a key scoped to the daemon's origin, and every 401 the client
// can receive clears it.
const API = JS['api.js'];
const stores = [...API.matchAll(/(?:localStorage|sessionStorage)\.setItem\(([^)]*)\)/g)].map(m => m[1]);
is('exactly one storage write carries the token', 1, stores.filter(a => /token/i.test(a)).length);
is('...in sessionStorage, under the per-origin key', true,
   /sessionStorage\.setItem\(k, JSON\.stringify\(\{ t: token, exp: tokenExp \}\)\)/.test(API)
   && /`\$\{LS_TOKEN\}:\$\{r\.base\}`/.test(API));
is('...and never in localStorage (it outlives a kill, and the app stays unlocked)', false,
   /localStorage\.setItem\(k, JSON\.stringify\(\{ t: token/.test(API));
const on401 = API.split('\n').filter(l => /if \(r\.status === 401/.test(l));
is('every 401 branch clears the token', '', on401.filter(l => !/clearToken\(\)/.test(l)).join(' | '));
is('...and there are 401 branches to check', true, on401.length >= 4);
is('clearToken removes the stored copy', true,
   /export function clearToken\(\) \{ token = null; tokenExp = 0; storeToken\(\); \}/.test(API));
// ...and a refused token locks the app: the adapter turns an AuthError into the lock screen
// rather than a page of red errors behind a session that is already gone.
is('a refused session locks the app', true, /e instanceof api\.AuthError\) lock\(\)/.test(SRC.adapter));

// ── 9. the probe asks a route the server really has ───────────────────────
// api.js decides between the daemon and the bundled fixtures by asking ONE endpoint, and reads a
// 401 there as proof of a fleet. An INVENTED path answers 401 only because the token gate runs
// before the routing table; a path in fleet-serve's OPEN set answers 200 and proves nothing.
is('the probe path is a route fleet-serve has', true,
   new RegExp(`p === '${api.PROBE_PATH}'`).test(SERVE));
is('...and it sits behind the token gate', false,
   new RegExp(`OPEN = new Set\\(\\[[^\\]]*'${api.PROBE_PATH}'`).test(SERVE));
// One file knows where the fleet lives — the same invariant as "one file fetches".
is('only api.js reads the backend setting', '',
   ['phone.js', 'passkey.js', 'grid.js'].filter(f => /gf\.base/.test(JS[f])).join(','));

console.log(rows.join('\n'));
