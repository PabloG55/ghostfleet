// web/src/phone.jsx — the phone's app: web/ui's one app (web/ui/app.jsx), behind the passkey lock,
// over fleet-serve. Built to web/phone.js (vite.config.mjs) and loaded by web/index.html.
//
// What is the phone's own is only what no other app has: the lock (lock.jsx), the adapter over
// fleet-serve (adapter.js), push (push.js) and the service worker's ways in (a tapped notification,
// a new shell taking over). Every screen is web/ui's, the same ones the team app draws.
import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import * as api from '../api.js';
import * as pk from '../passkey.js';
import * as push from './push.js';
import { FleetProvider, useFleet } from '../ui/adapter.jsx';
import { FleetApp } from '../ui/app.jsx';
import { Toasts, usePoll, ago, Btn, toast } from '../ui/ui.jsx';
import { go } from '../ui/history.js';
import { useLang } from '../ui/lang.js';
import { unbind } from '../ui/agent.js';
import { t } from '../ui/i18n.js';
import { phoneAdapter } from './adapter.js';
import { Lock } from './lock.jsx';
// The same stylesheets as the team app, in its order (ee/team/web/src/main.jsx), less its own.
// brand/ is not in the npm package, so its tokens are bundled into phone.css rather than linked.
// The fonts are vendored (web/fonts/fonts.css, linked from index.html), and so is xterm's CSS.
import '../../brand/tokens.css';
import '../ui/modality.js'; // the focus ring follows the keyboard, not a tap
import '../ui/ui.css';
import '../ui/skin.css';
import '../ui/terminal.css';

// A notification's way in (sw.js opens the app on one of these, or posts it to an open window).
// The old screens' names, mapped to the pages that have their content now. Read once at boot and
// spent after the unlock, never instead of it.
const WAYS_IN = { '#jarvis': '/', '#waiting': '/queue', '#reviews': '/reviews' };
let wantPlace = WAYS_IN[location.hash] || null;
if (wantPlace) { try { history.replaceState(null, '', location.pathname + location.search + '#/'); } catch {} }
// A LINK IS THE OTHER THING THAT SAYS WHERE TO GO: an address naming a place (a link opened, a desk
// tab reloaded after its session ran out) is where the FIRST unlock of this page lands. Spent once:
// a relock later is a login like any other, and a login lands on the main page.
let linkPlace = !wantPlace && location.hash && location.hash !== '#/' && location.hash !== '#';

// What is true of every page goes across the top of all of them (web/ui's demo bar): demo data,
// or a server that stopped answering. THE FLEET STAYS ON SCREEN WHEN IT DOES: the poll keeps the
// last answer, and the bar says how old it is — the question this app answers is "is anything
// blocked on me", and the answer from ten minutes ago, dated, is worth more than a blank page.
function Bar({ error, okAt }) {
  if (api.mode() === 'fixtures') return <div class="demo-bar" role="status">{t('lock.fixturesGate')}</div>;
  if (!error || error instanceof api.AuthError) return null;
  return <div class="demo-bar off" role="status">{okAt ? t('phone.offline', { ago: ago((Date.now() - okAt) / 1000) }) : t('phone.offlineNever')}</div>;
}

// The one-tap offer of notifications (push.js offerWanted says when), on the first page, as it was
// on the old Projects screen. Called from the tap: push.enable()'s first await is the permission
// request itself, so the gesture is still live when iOS asks whether it counts as one.
const atHome = () => /^#?\/?$/.test(location.hash || '');
function PushOffer() {
  const [want, setWant] = useState(false);
  const [home, setHome] = useState(atHome);
  useEffect(() => { const f = () => setHome(atHome()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      let laterAt = 0;
      try { laterAt = Number(localStorage.getItem(push.LATER_KEY)) || 0; } catch {}
      const base = { server: api.mode() === 'server', token: api.haveToken(), blocked: push.blockedReason(t), laterAt };
      if (!push.offerWanted({ ...base, on: false })) return;            // decided without asking anything
      let on = true;
      try { on = !!(await push.state(t)).on; } catch {}
      if (live) setWant(push.offerWanted({ ...base, on }));
    })();
    return () => { live = false; };
  }, []);
  if (!want || !home) return null;
  const turnOn = async () => {
    try { await push.enable(t); setWant(false); toast(t('push.onNow'), 'good'); }
    catch (e) { if (push.permission() === 'denied') setWant(false); toast(String((e && e.message) || e), 'bad'); }
  };
  const later = () => { try { localStorage.setItem(push.LATER_KEY, String(Date.now())); } catch {} setWant(false); };
  return (
    <div class="notify-bar" role="status">
      <span class="grow">{t('push.offer')}</span>
      <span class="notify-btns"><Btn kind="primary sm" onClick={turnOn}>{t('push.turnOn')}</Btn><Btn kind="ghost sm" onClick={later}>{t('push.notNow')}</Btn></span>
    </div>
  );
}

function Phone() {
  const fleet = useFleet();
  const { data, error } = usePoll(() => fleet.projects(), 5000, []);
  const okAt = useRef(0);
  useEffect(() => { if (data) okAt.current = Date.now(); }, [data]);
  useEffect(() => { push.sync(); }, []);
  return (
    <FleetApp name="ghostfleet" sub={t('lock.tagline')} projects={data?.projects} hosts={data?.hosts}
              frame={{ banner: <><Bar error={error} okAt={okAt.current} /><PushOffer /></> }} />
  );
}

function Root() {
  useLang();                                  // a language change redraws everything
  const [locked, setLocked] = useState(true);
  const [ver, setVer] = useState(0);          // a new session is a new app: nothing kept from the last one
  const lock = () => {
    api.clearToken();
    unbind();
    setLocked(true);
  };
  const fleet = useMemo(() => phoneAdapter({ lock, go, place: () => null }), [ver]);

  // §5: a passkey whenever there is no live session. The token dies after 15 minutes without a
  // request, and that expiry is what brings the sensor back.
  useEffect(() => {
    let hidByCeremony = false;
    const vis = () => {
      if (document.hidden) { hidByCeremony = pk.busy(); return; }   // the Face ID sheet hides the page too
      if (!hidByCeremony) pk.arm();
      hidByCeremony = false;
      if (!api.haveAccess()) { if (!locked) lock(); else tryAuto(); }
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [locked]);

  const landed = () => {
    pk.release();
    const to = wantPlace || (linkPlace ? null : '/');
    wantPlace = null; linkPlace = false;
    // Replaced, not pushed: an entry pushed while the lock is what is painted is previewed as the
    // lock by iOS's back swipe.
    if (to) { try { history.replaceState(null, '', location.pathname + location.search + '#' + to); } catch {} }
    setVer(v => v + 1);
    setLocked(false);
    if (!api.localTrusted()) pk.prepareFresh().catch(() => {});
  };
  const tryAuto = () => {
    if (document.hidden) return;
    pk.autoUnlock().then((r) => { if (r === 'ok') landed(); }).catch(() => {});
  };
  // A reload of this same page process can still have its session (the app took a new client):
  // that goes back to where it was. A cold launch has none and gets one automatic attempt.
  useEffect(() => {
    pk.arm();
    api.ready().then(() => api.localTrusted() ? 'ok' : pk.resume()).then((r) => {
      if (r === 'ok') { linkPlace = true; landed(); return; }
      if (r !== 'offline') tryAuto();
    }).catch(() => {});
  }, []);

  if (locked) return <><Lock onIn={landed} connection={fleet.settings.connection} /><Toasts /></>;
  return <FleetProvider adapter={fleet}><Phone key={ver} /></FleetProvider>;
}

// THE SHELL IS CACHE-FIRST, so a deploy reaches a phone that already has the app only when
// something re-navigates. When a new worker takes control, reload — never mid-sentence: a draft
// lives in memory, so a reload waits until nothing is being typed.
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  push.askShellVersion();
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const to = ev?.data?.open === 'jarvis' ? '/' : ev?.data?.open === 'waiting' ? '/queue' : null;
    if (to) { if (api.haveAccess()) go(to); else wantPlace = to; }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && !!a.value; };
    const swap = () => { if (typing()) { setTimeout(swap, 5000); return; } location.reload(); };
    swap();
  });
}
// Installed, by either signal: iOS has honoured navigator.standalone since before the media query
// existed, and the two have not always agreed.
const markStandalone = () => { try { document.documentElement.classList.toggle('standalone', push.standalone()); } catch {} };
markStandalone();
addEventListener('resize', markStandalone);
addEventListener('orientationchange', markStandalone);

render(<Root />, document.getElementById('app'));
