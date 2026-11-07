// The PEEK section's plain functions (mods/ghostfleet/hooks/peek-shape.js), as test/run.sh
// asks them. Every picture here is made on the spot from a formula: no fixture image, and
// nothing from anybody's screen.
//
//   node peek-check.mjs find       which pictures a conversation showed, and in what order
//   node peek-check.mjs png        the decoder against every PNG kind, filter and deflate mode
//   node peek-check.mjs ffmpeg DIR JPEG/GIF/WebP through ffmpeg, from a file and from stdin
//   node peek-check.mjs noff DIR   the same with no ffmpeg on PATH: exit 127, never a hang
//   node peek-check.mjs cells      the half-block Raster at every width from 4 to 160
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const P = await import(path.join(ROOT, 'mods/ghostfleet/hooks/peek-shape.js'))

// ── a PNG encoder, small and deliberate: every colour type and filter the decoder handles ──

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
// rows: one Uint8Array of packed samples per row; filters cycle 0..4 row by row.
function png({ width, height, depth, ctype, rows, palette, trns, zopts }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]
  const bpp = Math.max(1, (channels * depth) >> 3)
  const stride = Math.ceil(width * channels * depth / 8)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const f = y % 5, cur = rows[y], up = y ? rows[y - 1] : new Uint8Array(stride)
    raw[y * (stride + 1)] = f
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = up[x], c = x >= bpp ? up[x - bpp] : 0
      let pr = 0
      if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      raw[y * (stride + 1) + 1 + x] = (cur[x] - pr) & 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = ctype
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(palette ? [chunk('PLTE', palette)] : []), ...(trns ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', zlib.deflateSync(raw, zopts)), chunk('IEND', Buffer.alloc(0))])
}

// The picture every case draws, as RGBA: a gradient with a hard edge and a transparent hole.
const W = 37, H = 23
const want = (x, y) => [(x * 7) & 255, (y * 11) & 255, ((x + y) * 5) & 255, (x - 18) ** 2 + (y - 11) ** 2 < 25 ? 0 : 255]

function cases() {
  const out = []
  const zmodes = { stored: { level: 0 }, fixed: { strategy: zlib.constants.Z_FIXED }, dynamic: { level: 9 }, fast: { level: 1 } }
  for (const [zname, zopts] of Object.entries(zmodes)) {
    // RGBA 8 and RGB 8
    out.push({ name: `rgba8/${zname}`, alpha: true, ...packed(6, 8, zopts, (x, y) => want(x, y)) })
    out.push({ name: `rgb8/${zname}`, ...packed(2, 8, zopts, (x, y) => want(x, y).slice(0, 3)) })
  }
  out.push({ name: 'rgba16', alpha: true, ...packed(6, 16, {}, (x, y) => want(x, y)) })
  out.push({ name: 'gray8', gray: true, ...packed(0, 8, {}, (x, y) => [want(x, y)[0]]) })
  out.push({ name: 'graya8', gray: true, alpha: true, ...packed(4, 8, {}, (x, y) => [want(x, y)[0], want(x, y)[3]]) })
  // Palette at every depth: indices are (x+y) mod the palette's size.
  for (const depth of [1, 2, 4, 8]) {
    const n = 1 << depth
    const palette = Buffer.alloc(n * 3); for (let i = 0; i < n; i++) { palette[i * 3] = i * 37 & 255; palette[i * 3 + 1] = i * 91 & 255; palette[i * 3 + 2] = 255 - i }
    const trns = Buffer.from([0]) // index 0 transparent
    const rows = []
    for (let y = 0; y < H; y++) {
      const r = new Uint8Array(Math.ceil(W * depth / 8))
      for (let x = 0; x < W; x++) { const i = (x + y) % n, bit = x * depth; r[bit >> 3] |= i << (8 - depth - (bit & 7)) }
      rows.push(r)
    }
    out.push({ name: `pal${depth}`, bytes: png({ width: W, height: H, depth, ctype: 3, rows, palette, trns }),
      expect: (x, y) => { const i = (x + y) % n; return [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], i === 0 ? 0 : 255] } })
  }
  return out
}
function packed(ctype, depth, zopts, sample) {
  const rows = []
  for (let y = 0; y < H; y++) {
    const s = []
    for (let x = 0; x < W; x++) for (const v of sample(x, y)) { if (depth === 16) s.push(v, (v * 3) & 255); else s.push(v) }
    rows.push(Uint8Array.from(s))
  }
  const expect = (x, y) => {
    const v = sample(x, y)
    if (ctype === 0) return [v[0], v[0], v[0], 255]
    if (ctype === 4) return [v[0], v[0], v[0], v[1]]
    if (ctype === 2) return [...v, 255]
    return v
  }
  return { bytes: png({ width: W, height: H, depth, ctype, rows, zopts }), expect }
}

const cmd = process.argv[2]

if (cmd === 'find') {
  const cwd = '/w/acme-api', home = '/home/u'
  const msgs = [
    { role: 'user', text: 'here [Image #4] and [Image #3], also ~/shots/a.png', toolUses: [] },
    { role: 'assistant', text: 'Saved to shots/b.jpeg. See `../acme-web/c.webp`, not file:///x/d.png', toolUses: [
      { input: { command: 'fleet-look http://localhost:3000' }, text: 'wrote /tmp/look/e.png\n' }] },
    { role: 'assistant', text: 'quoting [Image #9] is no paste; and ~/shots/a.png again.', toolUses: [] },
    { role: 'user', text: 'what is /w/acme-api/notes.txt or a /path with space.png', toolResults: [{ text: 'f.GIF' }] },
  ]
  const refs = P.picturesIn(msgs, { cwd, home })
  console.log(refs.map(r => r.kind === 'paste' ? r.label : r.path).join(' | '))
} else if (cmd === 'png') {
  const bad = []
  let n = 0
  for (const c of cases()) {
    n++
    const pic = P.decodePng(new Uint8Array(c.bytes))
    if (!pic || pic.width !== W || pic.height !== H) { bad.push(`${c.name}: ${pic ? pic.width + 'x' + pic.height : 'null'}`); continue }
    let off = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const e = c.expect(x, y), p = (y * W + x) * 4
      for (let k = 0; k < 4; k++) if (pic.rgba[p + k] !== e[k]) off++
    }
    if (off) bad.push(`${c.name}: ${off} samples off`)
  }
  // A truncated stream and a non-PNG are null, never a throw.
  const cut = cases()[0].bytes.subarray(0, 60)
  const nulls = [P.decodePng(new Uint8Array(cut)), P.decodePng(new Uint8Array(32)), P.decodePng(null)].every(x => x === null)
  console.log(n, bad.length ? bad.join('; ') : 'exact', nulls ? 'nulls' : 'THREW-OR-DECODED')
} else if (cmd === 'ffmpeg' || cmd === 'noff') {
  const dir = process.argv[3]
  const src = path.join(dir, 'grad.png')
  fs.writeFileSync(src, cases()[0].bytes)
  const env = cmd === 'noff' ? { ...process.env, PATH: path.join(dir, 'no-such-bin') } : process.env
  const run = (argv, input) => spawnSync(argv[0], argv.slice(1), { input, env, timeout: 10_000 })
  if (cmd === 'noff') {
    const a = run(P.ffmpegFileArgv(src)), b = run(P.ffmpegStdinArgv(), fs.readFileSync(src).toString('base64'))
    console.log(a.status, b.status)
  } else {
    const out = []
    for (const ext of ['jpg', 'gif', 'webp']) {
      const f = path.join(dir, `grad.${ext}`)
      try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, f], { timeout: 10_000 }) } catch { out.push(`${ext}:no-encoder`); continue }
      const bytes = new Uint8Array(fs.readFileSync(f))
      const s = P.sniff(bytes)
      const a = run(P.ffmpegFileArgv(f)), b = run(P.ffmpegStdinArgv(), Buffer.from(bytes).toString('base64'))
      const pa = a.status === 0 ? P.parsePam(P.fromBase64(a.stdout.toString())) : null
      const pb = b.status === 0 ? P.parsePam(P.fromBase64(b.stdout.toString())) : null
      out.push(`${ext}:${s && s.format}:${s && s.width}x${s && s.height}:file=${pa ? pa.width + 'x' + pa.height : a.status}:stdin=${pb ? pb.width + 'x' + pb.height : b.status}`)
    }
    // A large picture comes back no larger than the thumb, its shape kept.
    const big = path.join(dir, 'big.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1200x2600:rate=1', '-frames:v', '1', big], { timeout: 20_000 })
    const c = run(P.ffmpegFileArgv(big))
    const pc = c.status === 0 ? P.parsePam(P.fromBase64(c.stdout.toString())) : null
    out.push(`big:${pc ? pc.width + 'x' + pc.height : c.status}`)
    console.log(out.join(' '))
  }
} else if (cmd === 'cells') {
  const pic = P.decodePng(new Uint8Array(cases()[0].bytes))
  let over = 0, unsquare = 0
  for (let cols = 4; cols <= 160; cols++) for (const rows of [3, 10, 40]) {
    const r = P.rasterOf(pic, cols, rows)
    if (!r || r.cols > cols || r.rows > rows) { over++; continue }
    if (P.fromBase64(r.cells).length !== r.cols * r.rows * 12) over++
    // Square pixels: width : height in pixels is the picture's, within one pixel's rounding.
    const ratio = r.cols / (r.rows * 2), true_ = W / H
    if (r.cols > 8 && Math.abs(ratio - true_) / true_ > 0.2) unsquare++
  }
  // The transparent hole is the terminal's own background, not black: one cell at its middle.
  const r = P.rasterOf(pic, W, Math.ceil(H / 2))
  const b = P.fromBase64(r.cells), v = new DataView(b.buffer, b.byteOffset)
  const mid = (5 * r.cols + 18) * 12
  const hole = [v.getUint32(mid, true), v.getUint32(mid + 4, true), v.getUint32(mid + 8, true)]
  console.log(over, unsquare, `${r.cols}x${r.rows}`, hole[0] === 0x20 && hole[1] === P.DEFAULT_COLOR && hole[2] === P.DEFAULT_COLOR ? 'hole=default' : `hole=${hole.map(x => x.toString(16))}`)
} else {
  console.error('usage: peek-check.mjs find|png|ffmpeg DIR|noff DIR|cells')
  process.exit(2)
}
