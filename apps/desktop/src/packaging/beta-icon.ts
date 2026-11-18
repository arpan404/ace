/**
 * The beta build's app icon (ADR 0177): the stable master with its bottom-right corner peeled
 * back like a sticker, showing orange underneath: a sneak peek. A beta in the Dock is never
 * mistaken for stable, and the tile, its clip and the mark stay the master's own, so the two
 * icons never drift. `scripts/icons.ts --beta` rasterizes it while a beta packages; nothing is
 * committed.
 *
 * The peel is drawn on the master's 1024 canvas. It folds along the line from (924, 700) on the
 * tile's right edge to (700, 924) on its foot, so the rounded corner lifts. Every point of the
 * curled flap lies past x + y = 1490, beyond the mark's lower-right tip (about 1465), so the
 * mark is never covered.
 */
const peel = `
  <defs>
    <linearGradient id="peel-under" x1="760" y1="760" x2="924" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffb24a"/>
      <stop offset="1" stop-color="#ff6a12"/>
    </linearGradient>
    <linearGradient id="peel-back" x1="700" y1="700" x2="860" y2="860" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#b9bac2"/>
    </linearGradient>
    <filter id="peel-lift" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="-8" dy="-8" stdDeviation="10" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <g data-peel="beta">
    <path clip-path="url(#clip)" d="M924 700L700 924L1024 1024Z" fill="url(#peel-under)"/>
    <path d="M924 700Q830 760 745 745Q760 830 700 924Z" fill="url(#peel-back)" filter="url(#peel-lift)"/>
  </g>
`;

/** The master icon with its corner peeled, drawn last, above the mark. */
export function betaIcon(svg: string): string {
  const end = svg.lastIndexOf("</svg>");
  if (end === -1 || !svg.includes('id="clip"'))
    throw new Error("The icon master has no tile clip to peel the beta's corner in");
  return `${svg.slice(0, end)}${peel}${svg.slice(end)}`;
}
