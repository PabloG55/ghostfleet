// A signed-in headless Chrome on the demo, driven the way a person drives it: real key and mouse
// events through the DevTools protocol, not element.click(), because what these tests check is
// what the browser does with a press (focus, :focus-visible, the order of events).
import { rig } from './demo-rig.mjs';
import { launch, sleep } from '../../../../lib/browser.mjs';

const KEYS = {
  ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], Home: ['Home', 36], End: ['End', 35],
  Enter: ['Enter', 13, '\r'], ' ': ['Space', 32, ' '], Escape: ['Escape', 27], Tab: ['Tab', 9],
  Shift: ['ShiftLeft', 16],
};
function keyOf(k) {
  if (KEYS[k]) { const [code, vk, text] = KEYS[k]; return { key: k, code, vk, text }; }
  return { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
}

export async function browse(t, { user = 'admin', lang = 'en', width = 1280, height = 800 } = {}) {
  const r = await rig(t);
  const cookie = await r.login(user);
  await r.call('POST', '/api/lang', { lang }, cookie);
  const base = `http://127.0.0.1:${r.port}`;
  const b = await launch({ width, height, scale: 1 });
  t.after(() => b.close());
  const [name, value] = cookie.split('=');
  await b.call('Network.setCookie', { name, value, url: base });

  const press = async (k) => {
    const { key, code, vk, text } = keyOf(k);
    const modifiers = k === 'Shift' ? 8 : 0;
    await b.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text, modifiers });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(60);
  };
  const until = async (what, fn, ...args) => {
    for (let i = 0; i < 150; i++) { const v = await b.evaluate(fn, ...args); if (v) return v; await sleep(100); }
    throw new Error(`waited 15s for ${what}`);
  };
  // A mouse press and release in the middle of the first element the selector finds.
  const click = async (sel) => {
    const at = await until(sel, (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const rc = el.getBoundingClientRect();
      return rc.width ? { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 } : null;
    }, sel);
    const ev = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await b.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...ev });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...ev });
    await sleep(120);
  };
  const go = async (hash, sel) => {
    await b.call('Page.navigate', { url: `${base}/#${hash}` });
    await until(sel, (s) => !!document.querySelector(s), sel);
  };
  return { r, b, cookie, base, press, click, until, go };
}
