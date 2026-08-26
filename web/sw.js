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

// BUMPED WHEN THE CLIENT CHANGES — v20 can send a photo: a camera beside the composer,
// the original bytes up to the Mac, and the path it comes back with dropped into the box
// where you can see it before you send. An older client has no camera at all, so the
// feature is simply absent there rather than broken.
//   v19 STOPPED TRYING TO OUT-MANOEUVRE THE iOS KEYBOARD: the shell is 100dvh again and
// Safari pans as it likes. v18 put the client version back above the one already deployed.
// Neither left a line here, and this is that line — a gap in this block is
// indistinguishable from a version that changed nothing.
// v17 is the first client that can be NOTIFIED: it adds
// the push handler, the notification tap, the rotated-subscription repair and the settings
// section that turns it on. A phone on an older client has no push handler at all, so a
// subscription taken out by any means would deliver pushes to a worker that shows nothing —
// which on iOS is how a subscription gets revoked. This is therefore a bump where the OLD
// client is not merely stale but actively harmful, and the settings sheet says which one you
// are on.
//   v17 SKIPPED v16 BECAUSE THIS BRANCH ALREADY HELD IT, and this is the branch — so the
// numbers land out of order, which costs nothing: the value is a cache key, not a sequence.
// v16 made the shell follow the VISUAL viewport, so that opening the keyboard would not
// leave the browser scrolling the page around a composer it had covered. SUPERSEDED BY
// v19, which took it out again: on a real iPhone it pinned the composer to the top of the
// screen with the transcript black beneath it. Left here rather than deleted, because the
// next person to meet the iOS keyboard should find out that this was tried. Its other
// half — the bottom safe-area inset collapsing while the keyboard is up — is
// the kind you feel on every message you type.
// v15 drew the speaker icon instead of pasting an emoji of one (#82) and left no note here;
// this line is that note, because this block is the record of what each version changed and
// a gap in it is indistinguishable from a version that changed nothing. v14 says when a
// worker is thinking, so a sent prompt going quiet stops reading as a send that failed.
// v13 stops the phone clipping itself: the send button rendering "senc", the ⋯ half off
// the right edge, the page sliding sideways when the sheet opened, and a card grid whose
// track was a character wider than the screen. An old client keeps every one of them, and
// they are the kind you live with rather than report twice. v12 lets any message be played
// rather than only the newest, picks a voice, and unpins rotation so a tablet gets more
// than one column. (v12 and v13 both used to carry v13's sentence: a version comment
// rebased onto itself in #79 clobbered #78's line and left the duplicate behind. A history
// that describes the wrong release is worse than none, so it is corrected here — again,
// because the merge that brought v17 in restored the duplicate along with it.)
// v11 puts profile tabs on the Projects screen, so a
// phone on the old client cannot separate work from personal at all. v10 renders an
// assistant's markdown instead of showing
// its source, and adds a FILE (md.js) to the precache list, which is the version bump that
// matters most: an old shell has no md.js in its cache, so a phone that does not refetch is
// a phone whose chat cannot load. v9 stops the read-aloud spelling out shas, UUIDs,
// timestamps and paths, and stops every list losing the reader's place on the 5s poll: a
// phone that keeps the old client keeps the old voice AND keeps being thrown to the top of
// its own project list. v8 makes the running version VISIBLE on the device,
// because three rounds of "is the fix live?" were spent inferring it from a server log.
// If the settings sheet shows no `client` line at all, that IS the answer: the client is
// older than v8. v7 makes the client take a new one by itself: app.js
// reloads on `controllerchange`, so one cold open picks up a deploy instead of two. This
// is the last version anybody should have to install by hand. v6 stops the 5s poll while
// you are typing, and that was
// v14 adds the working indicator to the chat: a phone on v13 shows a sent prompt going
// quiet, which is the exact complaint, so an unbumped deploy of it is invisible.
// the bump that matters most so far: without it a phone keeps a client whose keyboard
// closes every five seconds, and the fix is invisible until the shell is refetched. v5
// renames every fixture: the demo data used to be real
// project and session names, which is fine in a private repo and not in a public one. v4
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
// CLIENT-HASH: 08acc6a0cd8d
// ...pinned to the bytes of everything precached below (test/helpers/pwa-check.mjs). Change
// any of them and the suite goes red with the hash to paste here — which is the moment to
// bump VERSION, so the two can never drift apart again.
const VERSION = 'ghostfleet-v20';
const SHELL = [
  './', './index.html', './app.css', './app.js', './api.js', './grid.js', './passkey.js',
  './ansi.js', './md.js',
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

// WHICH CLIENT AM I RUNNING? Nothing in the app answered that, and a cache-first shell is
// exactly the app where you need to know: a phone can serve /api/ calls for hours on a
// client older than the deploy, and neither the person holding it nor the person reading
// the server log can tell. The worker is the authority — it is the thing that decides
// which bytes you got — so it answers, and the app prints what it says.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION });
  }
});

// ── push: a bell, and one that ALWAYS rings ─────────────────────────────────
// iOS may revoke a subscription whose worker takes a push and shows no notification, so
// this handler has exactly one job and no discretion: show something. Every decision
// about whether Pablo should be disturbed was already made by the server, which knows
// when the phone last polled and can therefore tell "he is holding it" from "it is in a
// pocket" — see the suppression note in bin/fleet-serve.mjs. A worker that decides not
// to bother him costs the subscription, which is a far worse outcome than one buzz.
//
// THE PAYLOAD HAS NO PROSE IN IT. It carries a kind, a count, and at most four
// project/session identifiers, so every word below is written HERE, from an enum. A
// malformed or empty payload still shows a notification, because the alternative is
// silence plus a revoked subscription.
const PUSH_TAG = 'ghostfleet-attention';
function pushText(d) {
  // A PAYLOAD IT CANNOT READ STILL HAS TO RING, and it must not invent what it says. The
  // first draft rendered an empty payload as "1 sessions have answers" — a count and a
  // kind, both made up, from nothing. Say the true thing instead: something wants you and
  // this is not the surface that knows what.
  const usable = d && typeof d.n === 'number' && d.n > 0 && typeof d.kind === 'string';
  if (!usable) return { title: 'ghostfleet', body: 'something needs you — open to see which' };
  const n = d.n;
  const named = Array.isArray(d.sessions) ? d.sessions.filter(x => x && x.project && x.session) : [];
  const kind = d.kind === 'needs-you' ? 'needs-you' : d.kind === 'mixed' ? 'mixed' : 'answer';
  const verb = kind === 'needs-you' ? 'needs you' : kind === 'mixed' ? 'needs you' : 'has an answer';
  if (n === 1) {
    // ONE, SO NOT "1 sessions". In anonymous mode there is no name to put in front of the
    // verb, and a count of one printed through the plural branch is the tell that a lock
    // screen line was assembled rather than written — measured by rendering every shape
    // this can take, which is how both of these were found.
    return named.length === 1
      ? { title: `${named[0].session} ${verb}`, body: named[0].project }
      : { title: `a session ${verb}`, body: 'open ghostfleet to see which' };
  }
  const what = kind === 'needs-you' ? 'need you' : kind === 'mixed' ? 'want you' : 'have answers';
  return { title: `${n} sessions ${what}`,
           // No names to list is the POINT of anonymous mode, not a degraded version of
           // the other one, so it says what to do instead of showing an empty list.
           body: named.length ? named.map(x => `${x.project}/${x.session}`).join(' · ') : 'open ghostfleet to see which' };
}
self.addEventListener('push', e => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch { d = null; }
  const t = pushText(d || {});
  e.waitUntil(self.registration.showNotification(t.title, {
    body: t.body,
    tag: PUSH_TAG,            // a second buzz replaces the first rather than stacking
    renotify: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { at: (d && d.at) || 0 },
  }));
});

// Tapping it opens the app — the grid, not a deep link. The card list is one tap from
// everywhere and a URL that named a session would be a second route to keep in step with
// app.js's own navigation for no gain.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  })());
});

// A ROTATED SUBSCRIPTION IS A DEAD ONE, silently. The browser can replace an endpoint
// (an OS update, a reinstall) and the server keeps posting to the old one, where 410
// prunes it and push simply stops with nothing on screen to say so.
//
// This worker cannot repair that on its own: uploading a subscription needs the session
// token, and the token deliberately lives in the page's memory rather than in storage, so
// there is nothing here to authenticate with while the app is closed. So it does the half
// it can — take out a new subscription with the key the page stashed, and leave it where
// the page will find it — and web/app.js does the upload on the next open. It also
// compares endpoints on EVERY open, which is what covers a rotation this event never
// fired for.
const PUSH_KEY_URL = './__push-key';        // stashed by app.js at subscribe time
const PUSH_PENDING_URL = './__push-pending';
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(VERSION);
      let key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey;
      if (!key) { const hit = await c.match(PUSH_KEY_URL); if (hit) key = await hit.text(); }
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await c.put(PUSH_PENDING_URL, new Response(JSON.stringify(sub.toJSON ? sub.toJSON() : sub),
        { headers: { 'content-type': 'application/json' } }));
    } catch {}
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // never a verb
  const url = new URL(req.url);
  // The two push stash keys are cache entries, not files: nothing must go looking for
  // them on the network, and a 404 for one must not reach the shell fallback below.
  if (url.pathname.endsWith('/__push-key') || url.pathname.endsWith('/__push-pending')) {
    e.respondWith(caches.open(VERSION).then(c => c.match(req)).then(r => r || new Response('', { status: 404 })));
    return;
  }
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
