// web/sw.js — enough offline to show the last state rather than a blank page.
//
// Two strategies, because the two kinds of request fail differently:
//
//   the app itself (html/css/js/icons/fixtures) — CACHE FIRST. It changes when
//     fleet-serve is redeployed, never between one glance and the next, and it must
//     paint on a train. Revalidated in the background so the next open is current.
//
//   /api/* — NETWORK FIRST, falling back to the last successful response. A stale
//     grid with a timestamp beside it (app.js draws that) beats an error page: the
//     question this app answers is "is anything blocked on me", and the answer from
//     ten minutes ago is still worth something. A stale answer presented as LIVE
//     would be the lie, and that is the app's job to label, not this file's.
//
// Never caches a POST: /api/verb changes the fleet, and a replayed verb is a second
// spawn or a second stop.

// BUMPED WHEN THE CLIENT CHANGES — v6 is comments only (two of them still named a fixture
// v5 had renamed), and it is bumped anyway: the pin is on the BYTES, and a version that
// tracks "did this feel important" is a version somebody has to remember. v5 renames every
// fixture: the demo data used to be real project and session names, which is fine in a
// private repo and not in a public one. v4
// rebuilt the session screen as a chat (a composer, a shell that owns the viewport,
// history-backed back, speech) and added two fixtures. v3 added the pane view, which was a
// new file (ansi.js) and a new default for that screen. The rule below is why the bump is not
// optional and why forgetting it is worse than shipping nothing. The shell is served
// CACHE-FIRST, so a phone that already has v1 paints the old app.js on the first open
// after a deploy and only revalidates behind it — which for the two fixes in this version
// (same-origin detection, and the enrolment code) means the first look after deploying
// still shows a fixture fleet with no way to enrol. That is indistinguishable from the fix
// not working. A new name means install() refetches the shell and activate() drops the old
// cache, so the next open runs the new code.
// CLIENT-HASH: 76c38713ad7e
// ...pinned to the bytes of everything precached below (test/helpers/pwa-check.mjs). Change
// any of them and the suite goes red with the hash to paste here — which is the moment to
// bump VERSION, so the two can never drift apart again.
const VERSION = 'ghostfleet-v6';
const SHELL = [
  './', './index.html', './app.css', './app.js', './api.js', './grid.js', './passkey.js',
  './ansi.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './fixtures/projects.json', './fixtures/checkouts.json',
  './fixtures/grid-acme-api.json', './fixtures/grid-degraded.json',
  './fixtures/grid-free.json', './fixtures/grid-empty.json',
  './fixtures/settings-acme-api.json',
  './fixtures/session-acme-api-api-fix.json', './fixtures/session-acme-api-docs-pass.json',
  './fixtures/session-acme-api-master.json',
  './fixtures/pane-acme-api-api-fix.json', './fixtures/pane-acme-api-docs-pass.json',
  './fixtures/pane-acme-api-master.json',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // Individually, not addAll: one 404 in the list would reject the whole install and
    // leave the app with no offline copy at all, which is a silent failure — it looks
    // exactly like a browser that has not finished installing yet.
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never a verb
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith('/api/');

  if (isApi) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const fresh = await fetch(req);
        // Only a real answer is worth keeping. Caching a 401 would hand the app a
        // stale rejection every time it went offline.
        if (fresh.ok) c.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const hit = await c.match(req);
        if (hit) return hit;
        throw err;                                     // app.js turns this into "offline"
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: false });
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
    if (hit) { net.catch(() => {}); return hit; }       // revalidate behind the paint
    try { return await net; }
    catch (err) {
      // A navigation with nothing cached for that exact URL still deserves the shell.
      if (req.mode === 'navigate') {
        const shell = await c.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
