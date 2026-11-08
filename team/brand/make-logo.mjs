#!/usr/bin/env node
// team/brand/make-logo.mjs — the logo variants, from the grid's ship.
//
//     node team/brand/make-logo.mjs       # rewrites logo/*.svg and the manual's tokens block
//
// The logo IS the SHIP sprite in bin/fleet-grid.mjs: 32 × 16 pixels in half-blocks. It is
// read from the source, as web/icons/make-icons.mjs does, so a redrawn ship reaches the logo
// by running this and nothing else: a hand-drawn logo would be a second thing to keep in step
// with the grid. The SVGs are committed; nothing runs this at install time.
//
// It also copies tokens.css into manual.html (between the tokens:begin/end markers),
// because the manual has to be ONE page that opens on its own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRID = path.join(HERE, '..', '..', 'bin', 'fleet-grid.mjs');
const OUT = path.join(HERE, 'logo');

export function shipRows(src = fs.readFileSync(GRID, 'utf8')) {
  const m = /^const SHIP = \[\n([\s\S]*?)^\];/m.exec(src);
  if (!m) throw new Error('make-logo: cannot find SHIP in bin/fleet-grid.mjs');
  return m[1].split('\n').map(l => /'([^']*)'/.exec(l)).filter(Boolean).map(x => x[1]);
}

// Each character is two vertical pixels: █ both, ▀ the top one, ▄ the bottom one.
export function pixels(rows) {
  const px = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '▀' || ch === '█') px.push([x, y * 2]);
    if (ch === '▄' || ch === '█') px.push([x, y * 2 + 1]);
  }));
  return px;
}

// One path segment per horizontal run instead of one <rect> per pixel: the same drawing in a
// third of the bytes, and no seams between neighbouring pixels when scaled with antialiasing.
export function shipPath(px, dx = 0, dy = 0) {
  const ys = [...new Set(px.map(p => p[1]))].sort((a, b) => a - b);
  let d = '';
  for (const y of ys) {
    const xs = px.filter(p => p[1] === y).map(p => p[0]).sort((a, b) => a - b);
    for (let i = 0; i < xs.length;) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      d += `M${xs[i] + dx} ${y + dy}h${xs[j] - xs[i] + 1}v1h-${xs[j] - xs[i] + 1}z`;
      i = j + 1;
    }
  }
  return d;
}

// The ghost wake: the proposed refinement. Three rows under the hull that fray away like
// the hem of a bedsheet, in teal and more transparent each row. The ship does not change by
// a single pixel; what is added can be taken away and the grid's sprite is what remains.
export const WAKE = [
  { y: 16, xs: [6, 7, 10, 11, 14, 15, 18, 19], o: 0.6 },
  { y: 17, xs: [7, 11, 15, 19], o: 0.35 },
  { y: 18, xs: [11, 19], o: 0.15 },
];
const wake = (dx = 0, dy = 0, fill = '#5fd7d7') => WAKE.map(r =>
  `<path fill="${fill}" fill-opacity="${r.o}" d="${shipPath(r.xs.map(x => [x, r.y]), dx, dy)}"/>`).join('');

const C = { bg: '#0b0d10', white: '#ffffff', teal: '#5fd7d7', ink: '#0b0d10', paper: '#f4f6f8', tealPaper: '#0e7a81' };
const MONO = `'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

const svg = (vb, body, label, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${label}" shape-rendering="crispEdges"${extra}>` +
  `<title>${label}</title>${body}</svg>\n`;

// The wordmark: "ghostfleet" in bold mono and "team" in the accent color. textLength pins
// the widths, so a fallback font cannot knock the block out of line with the ship.
function wordmark(x, baseline, size, fg, accent, anchor = 'start') {
  const adv = size * 0.6;                     // a monospace advance: 0.6 em
  const a = 10 * adv, gap = adv * 0.55, b = 4 * adv, total = a + gap + b;
  const x0 = anchor === 'middle' ? x - total / 2 : x;
  return { width: total, body:
    `<text x="${x0}" y="${baseline}" font-family="${MONO}" font-weight="700" font-size="${size}" fill="${fg}" textLength="${a}" lengthAdjust="spacingAndGlyphs" shape-rendering="auto">ghostfleet</text>` +
    `<text x="${x0 + a + gap}" y="${baseline}" font-family="${MONO}" font-weight="500" font-size="${size}" fill="${accent}" textLength="${b}" lengthAdjust="spacingAndGlyphs" shape-rendering="auto">team</text>` };
}

export function variants(rows) {
  const px = pixels(rows);
  const d = shipPath(px);
  const ship = (fill, dx = 0, dy = 0, s = 1) =>
    `<path fill="${fill}" transform="translate(${dx} ${dy}) scale(${s})" d="${d}"/>`;

  const lockup = (fg, accent, bg) => {
    const w = wordmark(38, 12.5, 10, fg, accent);
    const W = Math.ceil(38 + w.width + 1);
    return svg(`0 0 ${W} 16`, (bg ? `<rect width="${W}" height="16" fill="${bg}"/>` : '') + ship(fg) + w.body,
      'ghostfleet team');
  };
  const stacked = (fg, accent) => {
    const w = wordmark(60, 70, 12, fg, accent, 'middle');
    return svg('0 0 120 78', ship(fg, 12, 0, 3) + w.body, 'ghostfleet team');
  };
  const icon = (full) => {
    // 512 a side; the ship at scale 10 (320 × 160) sits inside the central 64%, which is
    // the safe zone of an icon the launcher crops to a circle.
    const r = full ? 0 : 112;
    return svg('0 0 512 512',
      `<defs><radialGradient id="g" cx="50%" cy="46%" r="55%"><stop offset="0" stop-color="#5fd7d7" stop-opacity=".22"/><stop offset=".6" stop-color="#5fd7d7" stop-opacity="0"/></radialGradient>` +
      `<filter id="f" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="9" result="b"/><feFlood flood-color="#5fd7d7" flood-opacity=".55"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      `<rect width="512" height="512" rx="${r}" fill="${C.bg}"/><rect width="512" height="512" rx="${r}" fill="url(#g)"/>` +
      `<g filter="url(#f)">${ship(C.white, 96, 166, 10)}</g>` +
      `<g transform="translate(96 166) scale(10)">${wake()}</g>`,
      'ghostfleet team');
  };

  return {
    // the ship alone
    'mark.svg': svg('0 0 32 16', ship(C.white), 'ghostfleet'),
    'mark-ink.svg': svg('0 0 32 16', ship(C.ink), 'ghostfleet'),
    'mark-teal.svg': svg('0 0 32 16', ship(C.teal), 'ghostfleet'),
    'mark-mono.svg': svg('0 0 32 16', `<path fill="currentColor" d="${d}"/>`, 'ghostfleet'),
    'mark-ghost.svg': svg('0 0 32 19', ship(C.white) + wake(), 'ghostfleet'),
    // horizontal, with the wordmark
    'lockup-dark.svg': lockup(C.white, C.teal),
    'lockup-light.svg': lockup(C.ink, C.tealPaper),
    'lockup-mono-black.svg': lockup('#000000', '#000000'),
    'lockup-mono-white.svg': lockup('#ffffff', '#ffffff', C.bg),
    // stacked
    'lockup-stacked-dark.svg': stacked(C.white, C.teal),
    'lockup-stacked-light.svg': stacked(C.ink, C.tealPaper),
    // app icon and favicon
    'app-icon.svg': icon(false),
    'app-icon-maskable.svg': icon(true),
    'favicon.svg': svg('0 0 32 32', `<rect width="32" height="32" rx="7" fill="${C.bg}"/>` + ship(C.white, 0, 8), 'ghostfleet'),
  };
}

const TOKENS_RE = /(\/\* tokens:begin \*\/\n)[\s\S]*?(\/\* tokens:end \*\/)/;
export function injectTokens(html, css) {
  if (!TOKENS_RE.test(html)) throw new Error('make-logo: manual.html has no tokens:begin/end markers');
  return html.replace(TOKENS_RE, (_, a, b) => a + css + b);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, body] of Object.entries(variants(shipRows()))) {
    fs.writeFileSync(path.join(OUT, file), body);
    console.log(`logo/${file}  ${body.length} bytes`);
  }
  const manual = path.join(HERE, 'manual.html');
  if (fs.existsSync(manual)) {
    fs.writeFileSync(manual, injectTokens(fs.readFileSync(manual, 'utf8'), fs.readFileSync(path.join(HERE, 'tokens.css'), 'utf8')));
    console.log('manual.html  tokens up to date');
  }
}
