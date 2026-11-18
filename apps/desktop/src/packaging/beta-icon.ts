/**
 * The beta build's app icon (ADR 0177): the stable master in porcelain, a light tile with
 * graphite wings, so a beta in the Dock is never mistaken for stable. Only the master's paints
 * change; the tile, its clip and the mark are the master's own, so the two icons never drift.
 * `scripts/icons.ts --beta` rasterizes it while a beta packages; nothing is committed.
 */
const porcelain: Array<[element: string, id: string, content: string]> = [
  [
    "linearGradient",
    "fill",
    `<stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#eeeef1"/>
      <stop offset="1" stop-color="#d9dae0"/>`,
  ],
  [
    "radialGradient",
    "sheen",
    `<stop offset="0" stop-color="#fff" stop-opacity="0.4"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
  ],
  [
    "linearGradient",
    "ink",
    `<stop offset="0" stop-color="#2c2d31"/>
      <stop offset="1" stop-color="#0a0a0b"/>`,
  ],
  [
    "filter",
    "lift",
    `<feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.18"/>`,
  ],
];

/** The master icon repainted in porcelain. */
export function betaIcon(svg: string): string {
  return porcelain.reduce((out, [element, id, content]) => {
    const paint = new RegExp(`(<${element}\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(</${element}>)`);
    if (!paint.test(out))
      throw new Error(`The icon master has no ${element} #${id} to paint the beta icon with`);
    return out.replace(paint, (_, open: string, close: string) => `${open}${content}${close}`);
  }, svg);
}
