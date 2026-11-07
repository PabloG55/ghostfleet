// What PEEK (register.js) decides, as plain functions the suite runs with node: which pastes a
// draft or a prompt names, where a preview of one opens on this machine, which program shrinks
// or opens it, where Claude Code keeps a session's pasted images, where a hover target goes
// over a sent prompt, and how a picture becomes terminal cells when it is drawn in the terminal.
//
// THREE WAYS TO SHOW A PICTURE, picked once a session (previewMode):
//   window  macOS, not over SSH: a borderless panel by the pointer (./peek-window.js). The
//           picture's own pixels, so a screenshot's text reads; nothing to install.
//   kitty   Ghostty or kitty, NOT inside tmux: the terminal draws the PNG itself through the
//           kitty graphics protocol (the engine's `Image`). Inside tmux that needs
//           `allow-passthrough`, and every fleet session runs inside tmux with the outer
//           terminal's variables still in its environment, which is why TMUX rules it out.
//   cells   everywhere else, over SSH, and on Linux and WSL (no native window there yet): a
//           card of half-block cells, `▀`, two pixels a cell, each with its own colour. Any
//           true-colour terminal draws it, through tmux too; it shows a screenshot's layout,
//           not text you can read.
//
// NO DEPENDENCY. PNG is decoded here (zlib's inflate included). Anything else is shrunk to a
// PNG by what the machine already has (sips on macOS, ImageMagick elsewhere), and failing that
// read through ffmpeg as PAM, which carries its own size. With none of them the card is a line
// of text: the picture's name, size and format.

// ── what a draft or a prompt names ──────────────────────────────────────────

const PASTE_RE = /\[Image #(\d+)\]/g

// The `[Image #N]` numbers a text names, in the order it names them, each once.
export function pastesIn(text) {
  const out = []
  for (const m of String(text || '').matchAll(PASTE_RE)) {
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && !out.includes(n)) out.push(n)
  }
  return out
}

// Two lists of numbers that say the same, in the same order.
export const sameIds = (a, b) => a.length === b.length && a.every((n, i) => n === b[i])

// ── which bytes a `[Image #N]` is ────────────────────────────────────────────
//
// Three places, cheapest first. (1) Claude Code's own copy, in the session's temp folder,
// <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<project path, every non-alphanumeric a '-'>/
// <session id>/images/<N>.<ext>: what the reference behaviour reads, and a file the preview
// window can open as it is. It is not always there (one long session measured: two files for
// about eighty pastes). (2) The prompt being submitted: `prompt.submit` lists its images and
// the engine hands their bytes over. (3) The transcript, whose user message carries every
// paste as an image block: complete, and the most expensive to read. Bytes from (2) or (3) are
// written once into PEEK's own folder beside the session's images, so all three end as a file.

export const projectSlug = root => String(root || '').replace(/[^A-Za-z0-9]/g, '-')
// The folders the session's images can be in: the project root's slug, then the cwd's. A
// project path too long for one folder name gets a hash appended by Claude Code, so a caller
// that finds neither looks through the temp folder for the session id instead.
export function sessionDirs({ tmp = '/tmp', uid, root, cwd, sessionId }) {
  if (uid === '' || uid === undefined || !sessionId) return []
  const base = `${String(tmp || '/tmp').replace(/\/+$/, '')}/claude-${uid}`
  return [...new Set([root, cwd].filter(Boolean).map(projectSlug))].map(slug => `${base}/${slug}/${sessionId}`)
}
// The stored image of paste N among a folder's names: `<N>.<ext>` and nothing else (no `..`, no
// separator, nothing a name in the folder could smuggle in).
export function storedImage(names, n) {
  return (names || []).find(name => new RegExp(`^${Number(n)}\\.(png|jpe?g|gif|webp)$`, 'i').test(name)) || null
}
// The extension bytes of a known kind are written under.
export const EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }

// The transcript stores a prompt's pastes as image blocks after its text, in paste order, and
// the placeholders in the text are numbered in paste order too, so the k-th smallest number
// is the k-th image block. The text order is NOT the paste order once the person moves a
// placeholder while typing, which is why the pairing sorts the numbers rather than reading
// them left to right. A count that disagrees pairs only as far as both go.

export function pairPastes(numbers, images) {
  const ns = [...new Set(numbers)].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < Math.min(ns.length, images.length); i++) out.push({ n: ns[i], image: images[i] })
  return out
}

// From the Messages-API form of the conversation: N -> { mediaType, base64 }.
export function pastesFromApi(apiMessages) {
  const map = new Map()
  for (const m of apiMessages || []) {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
    const text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
    const images = m.content.filter(b => b && b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data)
      .map(b => ({ mediaType: String(b.source.media_type || ''), base64: String(b.source.data) }))
    for (const { n, image } of pairPastes(pastesIn(text), images)) map.set(n, image)
  }
  return map
}

// ── bytes ───────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t })()

export function fromBase64(s) {
  s = String(s || '')
  const out = new Uint8Array(Math.floor(s.length * 3 / 4) + 3)
  let n = 0, acc = 0, bits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? B64_INV[c] : -1
    if (v < 0) continue // padding, line breaks, whitespace
    acc = (acc << 6) | v; bits += 6
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff }
  }
  return out.subarray(0, n)
}

export function toBase64(bytes) {
  let s = ''
  const chunk = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    const t = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    chunk.push(B64[(t >> 18) & 63], B64[(t >> 12) & 63], b === undefined ? '=' : B64[(t >> 6) & 63], c === undefined ? '=' : B64[t & 63])
    if (chunk.length >= 8192) { s += chunk.join(''); chunk.length = 0 }
  }
  return s + chunk.join('')
}

// What a picture's first bytes say it is: { format, width, height }, null for none of the four.
export function sniff(b) {
  if (!b || b.length < 12) return null
  const u32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { format: 'png', width: b.length >= 24 ? u32(16) : 0, height: b.length >= 24 ? u32(20) : 0 }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { format: 'gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (tag === 'VP8X' && b.length >= 30) return { format: 'webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (tag === 'VP8 ' && b.length >= 30) return { format: 'webp', width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff }
    if (tag === 'VP8L' && b.length >= 25) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { format: 'webp', width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) } }
    return { format: 'webp', width: 0, height: 0 }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const m = b[o + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { o += m === 0xff ? 1 : 2; continue }
      const len = (b[o + 2] << 8) | b[o + 3]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { format: 'jpeg', width: (b[o + 7] << 8) | b[o + 8], height: (b[o + 5] << 8) | b[o + 6] }
      o += 2 + len
    }
    return { format: 'jpeg', width: 0, height: 0 }
  }
  return null
}

// ── inflate (RFC 1951), for PNG ─────────────────────────────────────────────

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// A canonical Huffman code as a table: counts[len], symbols in code order.
function huff(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16)
  for (const l of lengths) counts[l]++
  counts[0] = 0
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1]
  const symbols = new Uint16Array(lengths.length)
  lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s })
  return { counts, symbols }
}

let FIXED = null
function fixedTables() {
  if (FIXED) return FIXED
  const l = new Array(288)
  for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8
  FIXED = { lit: huff(l), dist: huff(new Array(30).fill(5)) }
  return FIXED
}

// Raw deflate -> bytes. `sizeHint` is the expected output size (PNG knows it), so the output
// buffer is allocated once instead of doubling its way there. Throws on a broken stream.
export function inflate(src, sizeHint = 0) {
  let out = new Uint8Array(Math.max(1024, sizeHint))
  let o = 0, pos = 0, bit = 0, buf = 0
  const need = n => {
    while (bit < n) { if (pos >= src.length) throw new Error('inflate: unexpected end'); buf |= src[pos++] << bit; bit += 8 }
  }
  const bits = n => { need(n); const v = buf & ((1 << n) - 1); buf >>>= n; bit -= n; return v }
  const grow = n => {
    if (o + n <= out.length) return
    let len = out.length * 2
    while (len < o + n) len *= 2
    const bigger = new Uint8Array(len); bigger.set(out.subarray(0, o)); out = bigger
  }
  const decode = t => {
    let code = 0, first = 0, index = 0
    for (let len = 1; len < 16; len++) {
      code |= bits(1)
      const count = t.counts[len]
      if (code - count < first) return t.symbols[index + (code - first)]
      index += count; first += count; first <<= 1; code <<= 1
    }
    throw new Error('inflate: bad code')
  }
  let last = 0
  while (!last) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      buf = 0; bit = 0
      if (pos + 4 > src.length) throw new Error('inflate: unexpected end')
      const len = src[pos] | (src[pos + 1] << 8); pos += 4
      if (pos + len > src.length) throw new Error('inflate: unexpected end')
      grow(len); out.set(src.subarray(pos, pos + len), o); o += len; pos += len
      continue
    }
    let lit, dist
    if (type === 1) ({ lit, dist } = fixedTables())
    else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4
      const cl = new Array(19).fill(0)
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3)
      const clt = huff(cl)
      const lens = []
      while (lens.length < hlit + hdist) {
        const sym = decode(clt)
        if (sym < 16) lens.push(sym)
        else if (sym === 16) { if (!lens.length) throw new Error('inflate: bad repeat'); const p = lens[lens.length - 1]; for (let r = 3 + bits(2); r > 0; r--) lens.push(p) }
        else if (sym === 17) for (let r = 3 + bits(3); r > 0; r--) lens.push(0)
        else for (let r = 11 + bits(7); r > 0; r--) lens.push(0)
      }
      lit = huff(lens.slice(0, hlit)); dist = huff(lens.slice(hlit, hlit + hdist))
    } else throw new Error('inflate: bad block type')
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) { grow(1); out[o++] = sym; continue }
      if (sym === 256) break
      const li = sym - 257
      if (li >= 29) throw new Error('inflate: bad length')
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li])
      const di = decode(dist)
      if (di >= 30) throw new Error('inflate: bad distance')
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di])
      if (d > o) throw new Error('inflate: distance too far')
      grow(len)
      for (let i = 0; i < len; i++, o++) out[o] = out[o - d]
    }
  }
  return out.subarray(0, o)
}

// ── PNG ─────────────────────────────────────────────────────────────────────

// A picture is { width, height, rgba }: 4 bytes a pixel, row-major.
// PNG -> picture, or null for one this does not read (interlaced, broken, too large), which
// the caller hands to ffmpeg instead. `maxPixels` bounds the work a hook can be made to do.
export function decodePng(b, { maxPixels = 12_000_000 } = {}) {
  try {
    const s = sniff(b)
    if (!s || s.format !== 'png') return null
    const u32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
    let o = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0
    let palette = null, trns = null
    const idat = []
    let idatLen = 0
    while (o + 8 <= b.length) {
      const len = u32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7])
      const d = b.subarray(o + 8, o + 8 + len)
      if (type === 'IHDR') { width = u32(o + 8); height = u32(o + 12); depth = d[8]; ctype = d[9]; interlace = d[12] }
      else if (type === 'PLTE') palette = d
      else if (type === 'tRNS') trns = d
      else if (type === 'IDAT') { idat.push(d); idatLen += d.length }
      else if (type === 'IEND') break
      o += 12 + len
    }
    if (!width || !height || width * height > maxPixels || interlace) return null
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null
    const z = new Uint8Array(idatLen)
    let k = 0
    for (const d of idat) { z.set(d, k); k += d.length }
    const bpp = Math.max(1, (channels * depth) >> 3)          // bytes per pixel, for the filters
    const stride = Math.ceil((width * channels * depth) / 8)  // bytes per row
    const raw = inflate(z.subarray(2), (stride + 1) * height)
    if (raw.length < (stride + 1) * height) return null
    // Unfilter in place, row by row.
    const rows = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]
      const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? rows[dst + x - bpp] : 0
        const u = y > 0 ? rows[up + x] : 0
        const c = x >= bpp && y > 0 ? rows[up + x - bpp] : 0
        let v = raw[src + x]
        if (f === 1) v += a
        else if (f === 2) v += u
        else if (f === 3) v += (a + u) >> 1
        else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c }
        rows[dst + x] = v & 0xff
      }
    }
    // Samples -> RGBA.
    const rgba = new Uint8Array(width * height * 4)
    const sample = (row, i) => { // the i-th sample of a row, scaled to 0..255 (palette: the index)
      if (depth === 8) return rows[row + i]
      if (depth === 16) return rows[row + i * 2]
      const per = 8 / depth, byte = rows[row + Math.floor(i / per)]
      const v = (byte >> (8 - depth * (1 + (i % per)))) & ((1 << depth) - 1)
      return ctype === 3 ? v : Math.round(v * 255 / ((1 << depth) - 1))
    }
    const tKey = trns && (ctype === 0 || ctype === 2) ? trns : null
    for (let y = 0; y < height; y++) {
      const row = y * stride
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4
        let r, g, bl, a = 255
        if (ctype === 3) {
          const i = sample(row, x)
          if (!palette || i * 3 + 2 >= palette.length) return null
          r = palette[i * 3]; g = palette[i * 3 + 1]; bl = palette[i * 3 + 2]
          if (trns && i < trns.length) a = trns[i]
        } else if (ctype === 0 || ctype === 4) {
          r = g = bl = sample(row, x * channels)
          if (ctype === 4) a = sample(row, x * channels + 1)
          else if (tKey && depth === 8 && r === tKey[1]) a = 0
        } else {
          r = sample(row, x * channels); g = sample(row, x * channels + 1); bl = sample(row, x * channels + 2)
          if (ctype === 6) a = sample(row, x * channels + 3)
          else if (tKey && depth === 8 && r === tKey[1] && g === tKey[3] && bl === tKey[5]) a = 0
        }
        rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = bl; rgba[p + 3] = a
      }
    }
    return { width, height, rgba }
  } catch {
    return null
  }
}

// ── ffmpeg, for everything else ─────────────────────────────────────────────
//
// One frame, scaled down to fit THUMB inside ffmpeg (so a 4000px photo never crosses `$` at
// full size), written as PAM with alpha and base64'd by the shell: the process API carries
// text, and PAM's header says the size it chose.

export const THUMB = { width: 240, height: 480 }
const SCALE = `scale='min(${THUMB.width},iw)':'min(${THUMB.height},ih)':force_original_aspect_ratio=decrease:flags=area`
const FF = input => `ffmpeg -nostdin -v error -i ${input} -frames:v 1 -vf "${SCALE}" -f image2pipe -c:v pam -pix_fmt rgba pipe:1 | base64`
const HAS_FF = 'command -v ffmpeg >/dev/null 2>&1 || exit 127'

// argv for a file on disk: the path rides as $1, never inside the script's text.
export const ffmpegFileArgv = path => ['/bin/sh', '-c', `${HAS_FF}; ${FF('"$1"')}`, 'peek', path]
// argv for bytes handed over as base64 on stdin (a pasted image). No temporary file.
// Exit 127 from either: there is no ffmpeg, and the picture is words.
export const NO_FFMPEG = 127

// PAM (P7) -> picture, or null.
export function parsePam(b) {
  if (!b || b.length < 3 || b[0] !== 0x50 || b[1] !== 0x37) return null
  let o = 0, head = ''
  while (o < b.length && o < 512) {
    head += String.fromCharCode(b[o++])
    if (head.endsWith('ENDHDR\n')) break
  }
  if (!head.endsWith('ENDHDR\n')) return null
  const field = k => Number((head.match(new RegExp(`\\n${k} (\\d+)`)) || [])[1])
  const width = field('WIDTH'), height = field('HEIGHT'), depth = field('DEPTH'), max = field('MAXVAL')
  if (!width || !height || !depth || max !== 255) return null
  const n = width * height
  if (b.length - o < n * depth) return null
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const s = o + i * depth, d = i * 4
    if (depth >= 3) { rgba[d] = b[s]; rgba[d + 1] = b[s + 1]; rgba[d + 2] = b[s + 2] }
    else { rgba[d] = rgba[d + 1] = rgba[d + 2] = b[s] }
    rgba[d + 3] = depth === 4 ? b[s + 3] : depth === 2 ? b[s + 1] : 255
  }
  return { width, height, rgba }
}

// ── scaling and cells ───────────────────────────────────────────────────────

// The box a w x h picture takes in cells, inside cols x rows: each cell is one pixel across
// and two down (the half-block), and a cell is about twice as tall as it is wide, so the
// pixels come out square. Returns the picture's size in pixels too.
export function fitCells(w, h, cols, rows) {
  cols = Math.max(1, Math.floor(cols)); rows = Math.max(1, Math.floor(rows))
  if (!w || !h) return { cols: 0, rows: 0, pw: 0, ph: 0 }
  const s = Math.min(cols / w, (rows * 2) / h)
  const pw = Math.max(1, Math.min(cols, Math.round(w * s)))
  const ph = Math.max(1, Math.min(rows * 2, Math.round(h * s)))
  return { cols: pw, rows: Math.ceil(ph / 2), pw, ph }
}

// Area-average resample (nearest where it grows), alpha-weighted so a transparent pixel's
// colour does not bleed into its neighbours.
export function resample(pic, tw, th) {
  const { width: w, height: h, rgba } = pic
  const out = new Uint8Array(tw * th * 4)
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * h / th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * h / th))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * w / tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * w / tw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4, al = rgba[p + 3]
        r += rgba[p] * al; g += rgba[p + 1] * al; b += rgba[p + 2] * al; a += al; n++
      }
      const d = (ty * tw + tx) * 4
      if (a) { out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a) }
      out[d + 3] = Math.round(a / n)
    }
  }
  return { width: tw, height: th, rgba: out }
}

// A picture made small enough to keep: what the module holds per picture and redraws from.
export function thumb(pic) {
  const { width: w, height: h } = pic
  if (w <= THUMB.width && h <= THUMB.height) return pic
  const s = Math.min(THUMB.width / w, THUMB.height / h)
  return resample(pic, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)))
}

const UPPER = 0x2580, LOWER = 0x2584, SPACE = 0x20
export const DEFAULT_COLOR = 0x01000000

// A picture -> the `Raster` that draws it in at most cols x rows cells:
// { cols, rows, cells } with `cells` the base64 of [codePoint, fg, bg] u32 triplets.
// A pixel that is mostly transparent is the terminal's own background, not black.
export function rasterOf(pic, cols, rows) {
  const fit = fitCells(pic.width, pic.height, cols, rows)
  if (!fit.cols) return null
  const px = resample(pic, fit.pw, fit.ph)
  const words = new Uint32Array(fit.cols * fit.rows * 3)
  const color = (x, y) => {
    if (y >= fit.ph) return DEFAULT_COLOR
    const p = (y * fit.pw + x) * 4
    if (px.rgba[p + 3] < 128) return DEFAULT_COLOR
    return ((px.rgba[p] << 16) | (px.rgba[p + 1] << 8) | px.rgba[p + 2]) >>> 0
  }
  for (let cy = 0; cy < fit.rows; cy++) for (let cx = 0; cx < fit.cols; cx++) {
    const top = color(cx, cy * 2), bottom = color(cx, cy * 2 + 1)
    const i = (cy * fit.cols + cx) * 3
    if (top === DEFAULT_COLOR && bottom === DEFAULT_COLOR) { words[i] = SPACE; words[i + 1] = DEFAULT_COLOR; words[i + 2] = DEFAULT_COLOR }
    else if (top === DEFAULT_COLOR) { words[i] = LOWER; words[i + 1] = bottom; words[i + 2] = DEFAULT_COLOR }
    else { words[i] = UPPER; words[i + 1] = top; words[i + 2] = bottom }
  }
  // Little-endian, as the Raster wants, whatever this machine's own order is.
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true)
  return { cols: fit.cols, rows: fit.rows, cells: toBase64(bytes) }
}

// ── where a preview opens, and with what ────────────────────────────────────

// The session's system, from `uname -s`.
export const platformOf = uname => {
  const u = String(uname || '').trim()
  return u === 'Darwin' ? 'macos' : u === 'Linux' ? 'linux' : 'other'
}

// How this session shows a picture: 'window' | 'kitty' | 'cells' (the header says what each
// is). `env` is the session's environment. CLAUDE_FLEET_PEEK names one outright, for a person
// who wants the cells on a Mac (or the window off): a mode this machine cannot draw is not
// taken from it, so `window` off macOS is still cells.
export function previewMode({ platform, env = {}, isInteractive = true }) {
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY)
  const kitty = !remote && !env.TMUX && (env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty'
    || env.TERM === 'xterm-kitty' || Boolean(env.KITTY_WINDOW_ID))
  // Over SSH a window would open on the other machine, and the terminal there cannot read a
  // file of this one: both are this machine's, so both are out.
  const window = !remote && isInteractive && platform === 'macos'
  const asked = String(env.CLAUDE_FLEET_PEEK || '').trim().toLowerCase()
  if (asked === 'cells') return 'cells'
  if (asked === 'window') return window ? 'window' : 'cells'
  if (asked === 'kitty') return kitty ? 'kitty' : 'cells'
  return kitty ? 'kitty' : window ? 'window' : 'cells'
}

// What the window is told: its longest side in points, and how long it may stay up even with
// the pointer still on the chip (move off and back on to open it again).
export const WINDOW = { size: 800, life: 120 }

// The argv that opens a picture in the system's viewer, for a click.
export const openArgv = (platform, file) => platform === 'macos' ? ['open', '-a', 'Preview', file] : ['xdg-open', file]

// The shrinkers each system is tried with, in order, and the argv of each: `file` written to
// `out` as a PNG whose longest side is at most `side` pixels (never enlarged). The first that
// works is remembered for the session.
export const SHRINKERS = { macos: ['sips', 'magick', 'convert'], linux: ['magick', 'convert'], other: ['magick', 'convert'] }
export function shrinkArgv(tool, file, out, side) {
  // `sips -Z` is a target, not a bound: measured, it ENLARGES a 100x50 picture to 800x400. So
  // the caller passes `side` only for a picture larger than it, and none means "as it is".
  if (tool === 'sips') return ['sips', '-s', 'format', 'png', ...(side ? ['-Z', String(side)] : []), file, '--out', out]
  return [tool, file, ...(side ? ['-resize', `${side}x${side}>`] : []), `PNG:${out}`]
}

// ── where the pointer targets go over a sent prompt ─────────────────────────
//
// Claude Code draws a sent prompt as a blank row, then `❯ ` and the text, and lists the images
// it carried under it, one row each, `  ⎿  [Image #N]`, in paste order. A hover target is an
// unpainted region laid over that text, so it has to know where the text is drawn.

// Columns before the text on the prompt's first line, and before `[Image #N]` in a listed row.
export const PROMPT_AT = 2
export const LISTED_AT = 5

// The `[Image #N]` on the prompt's FIRST line that can take a target: [{ n, left, width }].
// Past that line, or past where it could wrap, the place is a guess, so there is none; and
// only after text of one cell a character (no wide glyphs, no emoji before it).
export function tokenTargets(text, columns, has = () => true) {
  const line = String(text || '').split('\n')[0]
  const width = Math.max(0, (columns || 80) - 1)
  const out = []
  for (const m of line.matchAll(/\[Image #(\d+)\]/g)) {
    const n = Number(m[1]), left = PROMPT_AT + m.index
    if (out.some(t => t.n === n) || !has(n)) continue
    if (!/^[\u0020-\u02ff]*$/.test(line.slice(0, m.index)) || left + m[0].length > width) continue
    out.push({ n, left, width: m[0].length })
  }
  return out
}

// The listed rows under a sent prompt, in the order Claude Code lists them (by number):
// [{ n, bottom, left, width }], `bottom` the row's offset under the prompt's box.
export function listedTargets(ns, has = () => true) {
  return [...new Set(ns)].sort((a, b) => a - b).filter(n => has(n))
    .map((n, i) => ({ n, bottom: -1 - i, left: LISTED_AT, width: `[Image #${n}]`.length }))
}

// A chip's key back to the paste it stands for: `chip:N` (the row above the prompt), `sent:N`
// (a listed row under a sent prompt), `token:N` (the sent prompt's first line).
export function chipOf(element) {
  const m = /^(chip|sent|token):(\d+)$/.exec(String(element || ''))
  return m ? { n: Number(m[2]), where: m[1] } : null
}

// ── words ───────────────────────────────────────────────────────────────────

const kb = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

// The line under a picture, and the whole of what is shown where it cannot be drawn.
export function caption(ref, info = {}) {
  const parts = [ref.label]
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`)
  if (info.format) parts.push(info.format.toUpperCase())
  if (info.size) parts.push(kb(info.size))
  return parts.join(' · ')
}

// Why a picture is words and not cells, said once under its caption.
export const WHY = {
  missing: 'not on disk any more',
  link: 'a symbolic link: not followed',
  notImage: 'not a picture this can read',
  noDecoder: 'nothing here shrinks it (sips, ImageMagick or ffmpeg)',
  noBytes: 'not stored in this session',
  failed: 'could not be decoded',
}
