#!/usr/bin/env node
// heic-probe — answer the one question docs/attachments.md is blocked on, on a real phone.
//
//     node scripts/heic-probe.mjs $(tailscale ip -4)
//     …then open the printed URL on the iPhone and tap "Pick a photo".
//
// THE QUESTION. docs/attachments.md §3–§4 measured everything in Chrome on macOS: that a
// photo downscales to ~560 KB at 1600px (inside fleet-serve's existing 1 MB body cap), and
// that `createImageBitmap(Blob)` is the only downscale route the client's CSP allows. Both
// are load-bearing, and neither was measured where it matters. iOS hands out HEIC, and if
// Safari's createImageBitmap will not decode a HEIC Blob then the whole client-side path
// needs rethinking before any of the server side is worth building.
//
// WHY IT SERVES ITS OWN PAGE UNDER THE REAL CSP. bin/fleet-serve.mjs sends
// `default-src 'self'` on everything, and that is not a detail: measured in Chrome, a
// blob: or data: URL in an <img> is BLOCKED under it, and an inline <script> never runs at
// all. A probe served without that header would answer a question nobody asked. So this
// sets the identical header and, like the real client, keeps its script in a separate
// same-origin file.
//
// THIS IS A TEST, NOT A FEATURE. It writes nothing, stores nothing, and has no upload
// endpoint — the photo never leaves the phone. Its only POST carries a few lines of text
// back so the answer lands in your terminal instead of on a phone screen you then have to
// transcribe. Delete it, or just Ctrl-C it, when you have the answer.
import http from 'node:http';

const bind = process.argv[2];
const port = Number(process.argv[3] || 8799);
if (!bind) {
  console.error('usage: node scripts/heic-probe.mjs <bind-address> [port]');
  console.error('       node scripts/heic-probe.mjs $(tailscale ip -4)');
  console.error('');
  console.error('The phone has to reach it, so bind the tailnet address — the same one');
  console.error('fleet-serve uses. 127.0.0.1 works only if you are testing from this Mac.');
  process.exit(2);
}
// The same policy bin/fleet-serve.mjs sets. Copied deliberately rather than imported:
// if the real one ever changes, this probe should be re-checked against it on purpose.
const CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const JS = String.raw`
const out = document.getElementById('out');
const L = [];
const p = (s) => { L.push(s); out.textContent = L.join('\n'); };
const send = () => fetch('/r', { method: 'POST', body: L.join('\n') }).catch(() => {});
window.onerror = (m) => { p('window.onerror: ' + m); send(); };

document.getElementById('pick').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  L.length = 0;
  p('ua: ' + navigator.userAgent);
  // 1. WHAT DID iOS ACTUALLY HAND OVER? The picker sometimes transcodes HEIC to JPEG on
  //    the way out and sometimes does not; which it did changes what the error path has
  //    to say, though not the design (the canvas re-encodes either way).
  p('file: name=' + f.name + '  type=' + (f.type || '(none)') + '  size=' + f.size +
    ' B (' + (f.size / 1048576).toFixed(2) + ' MB)');

  // 2. THE QUESTION. Does Safari decode this Blob with no URL and no fetch involved?
  //    If this throws, the design in docs/attachments.md §3 does not survive contact.
  let bm;
  const t0 = performance.now();
  try {
    bm = await createImageBitmap(f);
    p('createImageBitmap: OK ' + bm.width + 'x' + bm.height +
      '  (' + Math.round(performance.now() - t0) + ' ms)');
  } catch (e) {
    p('createImageBitmap: FAILED — ' + e.name + ': ' + e.message);
    p('>>> This is the answer that changes the design. See docs/attachments.md §10.');
    await send();
    return;
  }

  // 3. Downscale + re-encode, which is also the HEIC->JPEG conversion if one happened.
  for (const W of [1600, 1280]) {
    const s = Math.min(1, W / bm.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bm.width * s);
    c.height = Math.round(bm.height * s);
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
    const t1 = performance.now();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob) { p(W + 'px: toBlob returned null'); continue; }
    const b64 = Math.round(blob.size * 4 / 3);
    p(W + 'px -> ' + c.width + 'x' + c.height + '  ' + blob.size + ' B (' +
      (blob.size / 1048576).toFixed(2) + ' MB)  type=' + blob.type +
      '  base64 ' + (b64 / 1048576).toFixed(2) + ' MB  ' +
      (b64 < 1048576 ? 'FITS the 1 MB cap' : 'OVER the 1 MB cap') +
      '  (' + Math.round(performance.now() - t1) + ' ms)');
  }

  // 4. The CSP claims from §4, re-checked on this browser rather than assumed.
  await new Promise((res) => {
    const i = new Image();
    i.onload = () => { p('blob: URL -> <img>: LOADED (CSP allows it here)'); res(); };
    i.onerror = () => { p('blob: URL -> <img>: BLOCKED (as measured in Chrome)'); res(); };
    i.src = URL.createObjectURL(f);
    setTimeout(() => { p('blob: URL -> <img>: timed out'); res(); }, 4000);
  });

  p('--- done; sent to the terminal ---');
  await send();
});
`;

const HTML = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>heic probe</title>
<style>body{font:15px/1.45 -apple-system,system-ui,sans-serif;margin:20px;background:#111;color:#eee}
label{display:block;background:#2d6;color:#000;padding:16px;border-radius:10px;text-align:center;
font-weight:600;margin-bottom:16px}input{display:none}
pre{white-space:pre-wrap;word-break:break-word;background:#000;padding:12px;border-radius:8px}</style>
<body>
<label for=pick>Pick a photo</label>
<input id=pick type=file accept="image/*">
<pre id=out>Tap above and choose a recent photo from the library
(one straight off the camera, not a screenshot).</pre>
<script src="./p.js"></script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/r') {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 65536) req.destroy(); });
    req.on('end', () => {
      console.log('\n══════ result from the phone ══════\n' + b + '\n═══════════════════════════════════\n');
      res.writeHead(204); res.end();
    });
    return;
  }
  const isJs = req.url === '/p.js';
  res.writeHead(200, {
    'content-type': isJs ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(isJs ? JS : HTML);
}).listen(port, bind, () => {
  console.log(`heic-probe listening on http://${bind}:${port}/`);
  console.log('Open that on the iPhone, tap "Pick a photo", choose a CAMERA photo.');
  console.log('The result prints here. Ctrl-C when you have it. Nothing is stored.');
});
