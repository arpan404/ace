/**
 * The beta build's app icon (ADR 0174): the stable master with a "BETA" band across the tile's
 * foot, so a beta in the Dock is never mistaken for stable. The band is clipped to the tile's
 * own rounded body (`#clip` in `build/icon.svg`), so the corners stay the system's shape.
 * `scripts/icons.ts --beta` rasterizes it while a beta packages; nothing is committed.
 */
export const betaBand = `
  <g clip-path="url(#clip)" data-band="beta">
    <rect x="100" y="752" width="824" height="172" fill="#f4f4f6"/>
    <text x="512" y="870" text-anchor="middle" fill="#0a0a0b"
      font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif"
      font-size="112" font-weight="700" letter-spacing="18">BETA</text>
  </g>
`;

/** The master icon with the band drawn last, above the glyph. */
export function withBetaBand(svg: string): string {
  const end = svg.lastIndexOf("</svg>");
  if (end === -1 || !svg.includes('id="clip"'))
    throw new Error("The icon master has no tile clip to draw the beta band in");
  return `${svg.slice(0, end)}${betaBand}${svg.slice(end)}`;
}
