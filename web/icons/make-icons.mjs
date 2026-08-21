#!/usr/bin/env node
// web/icons/make-icons.mjs — the home-screen icons, from the grid's own ship.
//
//     node web/icons/make-icons.mjs        # rewrites the PNGs beside this file
//
// The banner in bin/fleet-grid.mjs IS a bitmap: eight rows of half-block characters,
// each carrying two pixel rows, so SHIP is a 32 × 16 sprite drawn in C.white on the
// terminal's background. Rasterising that exact sprite is the whole icon — a
// hand-drawn logo would be a second thing to keep in step with the header, and the
// home screen is where the app is recognised.
//
// Zero dependencies, like everything else here: zlib and a CRC32 are enough to write a
// PNG, and node has zlib. The PNGs are committed, so nothing needs to run this at
// install time; run it when the ship changes.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRID = path.join(HERE, '..', '..', 'bin', 'fleet-grid.mjs');

// Lifted from the source rather than copied, so a redrawn ship reaches the icon by
// re-running this and nothing else.
function shipRows() {
  const src = fs.readFileSync(GRID, 'utf8');
  const m = /^const SHIP = \[\n([\s\S]*?)^\];/m.exec(src);
  if (!m) throw new Error('make-icons: cannot find SHIP in bin/fleet-grid.mjs');
  return m[1].split('\n')
    .map(l => /'([^']*)'/.exec(l))
    .filter(Boolean)
    .map(x => x[1]);
}

// Each character is two vertical pixels: █ both, ▀ top, ▄ bottom, space neither.
function bitmap(rows) {
  const w = Math.max(...rows.map(r => [...r].length));
  const h = rows.length * 2;
  const on = Array.from({ length: h }, () => new Uint8Array(w));
  rows.forEach((row, ry) => {
    [...row].forEach((ch, x) => {
      const top = ch === '█' || ch === '▀';
      const bot = ch === '█' || ch === '▄';
      if (top) on[ry * 2][x] = 1;
      if (bot) on[ry * 2 + 1][x] = 1;
    });
  });
  return { w, h, on };
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return buf => {
    let c = ~0;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (~c) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgb) {          // rgb: (x,y) -> [r,g,b]
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                           // filter: none
    for (let x = 0; x < width; x++) { const [r, g, b] = rgb(x, y); raw[o++] = r; raw[o++] = g; raw[o++] = b; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x0b, 0x0d, 0x10];              // the app background
const FG = [0xff, 0xff, 0xff];              // C.white — what banner() draws the ship in

const { w, h, on } = bitmap(shipRows());
// `pad` is the fraction of the canvas left as background around the sprite. A maskable
// icon is cropped to a circle by the launcher, so the safe zone is the middle 80% —
// 0.18 keeps the whole ship inside it at every size below.
function draw(size, pad = 0.18) {
  const inner = size * (1 - pad * 2);
  const scale = Math.max(1, Math.floor(Math.min(inner / w, inner / h)));
  const dw = w * scale, dh = h * scale;
  const ox = Math.floor((size - dw) / 2), oy = Math.floor((size - dh) / 2);
  return png(size, size, (x, y) => {
    const sx = Math.floor((x - ox) / scale), sy = Math.floor((y - oy) / scale);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return BG;
    return on[sy][sx] ? FG : BG;
  });
}

for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const out = path.join(HERE, file);
  fs.writeFileSync(out, draw(size));
  console.log(`${file}  ${size}×${size}  ${fs.statSync(out).size} bytes`);
}
