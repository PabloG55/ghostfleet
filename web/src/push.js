// web/src/push.js — this device's Web Push subscription (docs/mobile.md §9), behind Settings'
// "Notifications" switch. Carried over from the phone's old app.js unchanged in what it does;
// only the place it is drawn moved into web/ui.
//
// HOME SCREEN ONLY ON iOS, and that is not a preference to nudge: a Safari TAB has no
// `PushManager`, and `Notification.requestPermission` there resolves to a prompt that never
// appears. So the switch SAYS which state it is in — a permission dialog that silently never
// opens is indistinguishable from a broken switch.
import * as api from '../api.js';

export function standalone() {
  try { if (matchMedia('(display-mode: standalone)').matches) return true; } catch {}
  return navigator.standalone === true;                  // iOS's own, older spelling
}
const supported = () => !!(navigator.serviceWorker && typeof window !== 'undefined' && 'PushManager' in window
  && typeof Notification !== 'undefined');
export function permission() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  catch { return 'unsupported'; }
}
// iPadOS reports itself as a Mac, which is why the touch-point half is here: without it an iPad
// in a tab is told a desktop's story.
export function iosLike() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
}

// Why it CANNOT be turned on, in words that say what to do about it; '' when it can.
//   The home-screen rule is iOS's, so only iOS is told it: a desktop browser in a tab subscribes
// perfectly well. The capability check goes first because it is the measured half.
export function blockedReason(tr) {
  if (api.mode() === 'probing') return tr('push.probing');
  if (api.mode() !== 'server') return tr('push.fixtures');
  if (!supported()) return iosLike() && !standalone() ? tr('push.iosTab') : tr('push.noApi');
  if (iosLike() && !standalone()) return tr('push.iosTab');
  if (permission() === 'denied') return tr('push.denied');
  return '';
}

const b64uToBytes = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
};
async function registration() {
  if (!navigator.serviceWorker) return null;
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}
export async function current() {
  const reg = await registration();
  if (!reg || !reg.pushManager) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}

// The cache the worker is actually using, asked of the worker itself; a name that is
// wrong-but-harmless when it will not say (a stash it cannot reach costs one re-subscribe).
let swVersion = '';
export function shellVersion() { return swVersion; }
export async function askShellVersion() {
  try {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) { swVersion = 'no worker'; return swVersion; }
    const ch = new MessageChannel();
    swVersion = await new Promise((res) => {
      const tm = setTimeout(() => res('unknown'), 600);     // an old worker will not answer
      ch.port1.onmessage = (e) => { clearTimeout(tm); res((e.data && e.data.version) || 'unknown'); };
      c.postMessage({ type: 'version' }, [ch.port2]);
    });
  } catch { swVersion = 'unknown'; }
  return swVersion;
}
async function cacheName() {
  if (/^ghostfleet-v/.test(swVersion)) return swVersion;
  try { const keys = await caches.keys(); const hit = keys.find(k => /^ghostfleet-v/.test(k)); if (hit) return hit; } catch {}
  return 'ghostfleet-push';
}

// CALLED FROM THE TAP, and the first await is the permission request itself, so the gesture is
// still live when iOS asks whether it counts as one.
export async function enable(tr) {
  const why = blockedReason(tr);
  if (why) throw new Error(why);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(tr('push.notAllowed'));
  const k = await api.pushKey();
  if (!k || !k.key) throw new Error(tr('push.noKey'));
  const reg = await registration();
  if (!reg || !reg.pushManager) throw new Error(tr('push.noWorker'));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(k.key) });
  // Where sw.js can find it: on a rotated subscription the worker re-subscribes with the SAME
  // application key and cannot ask the server for it (no token). See sw.js pushsubscriptionchange.
  try { const c = await caches.open(await cacheName()); await c.put('./__push-key', new Response(k.key)); } catch {}
  const j = sub.toJSON ? sub.toJSON() : sub;
  await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
  try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
  return j.endpoint;
}
// Server FIRST: unsubscribing in the browser before the daemon is told leaves it posting into a
// 410, and "off" should be off the moment it says so.
export async function disable() {
  const sub = await current();
  const ep = sub ? (sub.endpoint || '') : '';
  try { if (ep) await api.pushUnsubscribe(ep); } catch {}
  try { if (sub) await sub.unsubscribe(); } catch {}
  try { localStorage.removeItem('gf.push.endpoint'); } catch {}
}
// On means on HERE (a subscription) and known THERE (the daemon has it).
export async function state(tr) {
  const why = blockedReason(tr);
  if (why) return { ready: false, why };
  const sub = await current();
  let known = false;
  try { known = !!(sub && (await api.pushKey())?.subscribed); } catch {}
  return { ready: true, on: !!sub && known, why: sub && !known ? tr('push.unknownThere') : '' };
}

// A subscription's endpoint can be REPLACED by the browser without asking (an OS update, a
// reinstall), and the daemon then posts into a 410 forever. sw.js catches the event it can and
// leaves the new subscription in the cache, but the event is not reliable everywhere — so this
// runs once per unlock: whatever the browser says our subscription is now, tell the server if it
// is not what we last sent.
let synced = false;
export async function sync() {
  if (synced || !api.haveToken() || api.mode() !== 'server') return;
  synced = true;
  try {
    try {
      const c = await caches.open(await cacheName());
      const pending = await c.match('./__push-pending');
      if (pending) {
        const j = await pending.json();
        if (j && j.endpoint && j.keys) {
          await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
          try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
        }
        await c.delete('./__push-pending');
      }
    } catch {}
    const sub = await current();
    if (!sub) return;
    const j = sub.toJSON ? sub.toJSON() : sub;
    let last = '';
    try { last = localStorage.getItem('gf.push.endpoint') || ''; } catch {}
    if (j.endpoint && j.endpoint !== last) {
      await api.pushSubscribe({ endpoint: j.endpoint, keys: j.keys });
      try { localStorage.setItem('gf.push.endpoint', j.endpoint); } catch {}
    }
  } catch {}
}
