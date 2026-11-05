import { oklchToHex } from "./colour.ts";
import type { Scheme } from "./types.ts";

/**
 * Chart series for published HTML visualizations (`--chart-1` … `--chart-6`): blue, red, green,
 * magenta, amber and cyan, 55–60° apart at one lightness per scheme, so each is distinct from
 * the others and reads on the theme's background. The app and html_preview both draw with these.
 */
const chartHues = [260, 30, 145, 330, 85, 200] as const;
const chartLightness: Record<Scheme, { l: number; c: number }> = {
  dark: { l: 0.78, c: 0.14 },
  light: { l: 0.55, c: 0.16 },
};

/** The six chart colours for a scheme, in series order. */
export function chartSeries(scheme: Scheme): readonly string[] {
  const { l, c } = chartLightness[scheme];
  return chartHues.map((hue) => oklchToHex(l, c, hue));
}
