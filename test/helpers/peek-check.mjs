// The PEEK section's plain functions (mods/ghostfleet/hooks/peek-shape.js), as test/run.sh
// asks them. Every picture here is made on the spot from a formula: no fixture image, and
// nothing from anybody's screen.
//
//   node peek-check.mjs mode       how a session shows a picture, per system and terminal
//   node peek-check.mjs targets    where the hover targets go over a sent prompt
//   node peek-check.mjs stored     which file in the session's temp folder a paste is
//   node peek-check.mjs shrink DIR the shrinkers' argv, and sips run for real where it is
//   node peek-check.mjs png        the decoder against every PNG kind, filter and deflate mode
//   node peek-check.mjs ffmpeg DIR JPEG/GIF/WebP through ffmpeg
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

if (cmd === 'mode') {
  // One letter per case: w(indow), k(itty), c(ells).
  const TMUX = '/tmp/tmux-501/cf-acme-api,1,0', SSH = '10.0.0.2 51000 10.0.0.1 22'
  const rows = [
    ['macos', { TERM_PROGRAM: 'tmux', TMUX }],                                  // a fleet session
    ['macos', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['macos', { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' }],
    ['macos', { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }],
    ['macos', { TERM_PROGRAM: 'tmux', TMUX, KITTY_WINDOW_ID: '1' }],            // inherited into tmux
    ['macos', { TERM_PROGRAM: 'tmux', TMUX, SSH_CONNECTION: SSH }],
    ['macos', { TERM_PROGRAM: 'ghostty', SSH_TTY: '/dev/ttys004' }],
    ['linux', { TERM: 'xterm-256color' }],
    ['linux', { TERM: 'xterm-kitty' }],
    ['other', { TERM: 'xterm-256color' }],
    ['macos', { TERM_PROGRAM: 'tmux', TMUX, CLAUDE_FLEET_PEEK: 'cells' }],
    ['linux', { TERM: 'xterm-256color', CLAUDE_FLEET_PEEK: 'window' }],          // not drawable here
  ]
  const letters = rows.map(([platform, env]) => P.previewMode({ platform, env })[0]).join('')
  // A session nobody is looking at (`claude -p`) opens no window.
  const headless = P.previewMode({ platform: 'macos', env: {}, isInteractive: false })[0]
  console.log(letters, headless, P.platformOf('Darwin\n'), P.platformOf('Linux'), P.platformOf('FreeBSD'),
    P.openArgv('macos', '/x/1.png').join(' '), P.openArgv('linux', '/x/1.png').join(' '))
} else if (cmd === 'targets') {
  const has = n => n !== 7
  const t = P.tokenTargets('look at [Image #1] and [Image #2] [Image #1] [Image #7]\nthen [Image #9]', 120, has)
  // A target that would run past the line's end, or after a wide glyph, is left out.
  const narrow = P.tokenTargets('a long line before it, and then [Image #1]', 30)
  const wide = P.tokenTargets('漢字 [Image #1]', 120)
  const l = P.listedTargets([2, 1, 7, 1], has)
  console.log(t.map(x => `${x.n}@${x.left}+${x.width}`).join(','), narrow.length, wide.length,
    l.map(x => `${x.n}@${x.bottom}:${x.left}`).join(','),
    ['chip:3', 'sent:12', 'token:4', 'chip:', 'x:1', 'chip:1/../2'].map(k => (P.chipOf(k) || { where: '-' }).where).join(','))
} else if (cmd === 'stored') {
  const dirs = P.sessionDirs({ tmp: '/var/t/', uid: '501', root: '/w/acme-api', cwd: '/w/acme-api/web', sessionId: 's1' })
  const same = P.sessionDirs({ uid: '501', root: '/w/acme-api', cwd: '/w/acme-api', sessionId: 's1' })
  const none = P.sessionDirs({ uid: '', root: '/w/acme-api', sessionId: 's1' }).length
  const names = ['13.png', '3.txt', '3.png.lnk', '../3.png', '3.JPG', '30.png', 'x3.png']
  console.log(dirs.join(' '), same.length, none, P.storedImage(names, 3), P.storedImage(names, 13), P.storedImage(names, 4))
} else if (cmd === 'shrink') {
  const a = P.shrinkArgv('sips', '/x/a.jpg', '/y/a.png', 800).join(' ')
  const b = P.shrinkArgv('sips', '/x/a.jpg', '/y/a.png').join(' ')
  const c = P.shrinkArgv('magick', '/x/a.jpg', '/y/a.png', 800).join(' ')
  let real = 'no-sips'
  const dir = process.argv[3]
  if (dir && spawnSync('sips', ['--help']).status === 0) {
    // Run for real: a big picture comes down to the side, a small one stays as it is.
    const big = path.join(dir, 'big.png'), small = path.join(dir, 'small.png')
    const solid = (w, h) => png({ width: w, height: h, depth: 8, ctype: 2, rows: Array.from({ length: h }, () => new Uint8Array(w * 3).fill(90)) })
    fs.writeFileSync(big, solid(1600, 400)); fs.writeFileSync(small, solid(100, 50))
    const size = f => { const s = P.sniff(new Uint8Array(fs.readFileSync(f))); return s ? `${s.width}x${s.height}` : 'unread' }
    for (const [f, side] of [[big, 800], [small, undefined]]) {
      const o = f.replace('.png', '.out.png'), argv = P.shrinkArgv('sips', f, o, side)
      spawnSync(argv[0], argv.slice(1))
    }
    real = `${size(big.replace('.png', '.out.png'))} ${size(small.replace('.png', '.out.png'))}`
  }
  console.log(`${a} | ${b} | ${c} | ${real}`)
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
    console.log(run(P.ffmpegFileArgv(src)).status)
  } else {
    const out = []
    for (const ext of ['jpg', 'gif', 'webp']) {
      const f = path.join(dir, `grad.${ext}`)
      try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, f], { timeout: 10_000 }) } catch { out.push(`${ext}:no-encoder`); continue }
      const bytes = new Uint8Array(fs.readFileSync(f))
      const s = P.sniff(bytes)
      const a = run(P.ffmpegFileArgv(f))
      const pa = a.status === 0 ? P.parsePam(P.fromBase64(a.stdout.toString())) : null
      out.push(`${ext}:${s && s.format}:${s && s.width}x${s && s.height}:file=${pa ? pa.width + 'x' + pa.height : a.status}`)
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
  console.error('usage: peek-check.mjs mode|targets|stored|shrink DIR|png|ffmpeg DIR|noff DIR|cells')
  process.exit(2)
}
