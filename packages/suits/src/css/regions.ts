import type { SuitManifest, SuitProblem, SuitRegionStyle } from "@ace/protocol/suits";
import { suitRegions } from "@ace/protocol/suit-parts";
import { sanitiseSuitCss } from "./sanitise.ts";

/*
 * `SuitManifest.regions` as CSS: each value becomes `--suit-<region>-<name>` on its region, checked
 * by the same sanitiser as suit.css, so a background named in suit.json can't reach further than
 * one written in CSS. Pure.
 */

const names = [
  ["background", "background"],
  ["border", "border"],
  ["shadow", "shadow"],
  ["backdropFilter", "backdrop-filter"],
] as const satisfies readonly (readonly [keyof SuitRegionStyle, string])[];

export function regionCss(input: {
  id: string;
  manifest: Pick<SuitManifest, "regions">;
  assets: ReadonlySet<string>;
  url(path: string): string;
}): { css: string; problems: SuitProblem[] } {
  const css: string[] = [];
  const problems: SuitProblem[] = [];
  for (const region of suitRegions) {
    const style = input.manifest.regions?.[region];
    if (!style) continue;
    for (const [key, name] of names) {
      const value = style[key];
      if (value === undefined) continue;
      const text = `[data-part="${region}"]{--suit-${region}-${name}:${value}}`;
      const result = sanitiseSuitCss({ ...input, text });
      css.push(result.css);
      for (const { line: _line, ...problem } of result.problems)
        problems.push({ ...problem, field: `regions.${region}.${key}` });
    }
  }
  return { css: css.filter(Boolean).join("\n"), problems };
}
