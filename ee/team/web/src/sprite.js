// ghostfleet's own SHIP sprite (bin/fleet-grid.mjs), pixel for pixel — the same drawing as the
// app icon. Half-blocks carry two pixel rows per text row: ▀ the top one, ▄ the bottom, █ both.
export const SHIP = [
  '         ▄▄▄▄▄▄█                ',
  '         ▀▀▀▀▀ █                ',
  '          ▄▄███████▄▄▄          ',
  '       ▄██████ ███ ████▄      ▄▀',
  '     ▄██████████████████    ▄▀  ',
  '   ▄██▀▀████▀▀████▀▀███   ▄▀    ',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀      ',
  '  ▀▀▀█████████████████▀▀        ',
];
export const PIXELS = (() => {
  const px = [];
  SHIP.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '▀' || ch === '█') px.push([x, y * 2]);
    if (ch === '▄' || ch === '█') px.push([x, y * 2 + 1]);
  }));
  return px;
})();
// The top of the mast, where a ship hangs its lamp.
export const MAST = [15, 0];
