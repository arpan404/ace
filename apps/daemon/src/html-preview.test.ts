import { expect, test } from "vitest";
import { contrastRatio, deltaE, parseOpaqueColor } from "@ace/themes";
import { previewTheme } from "./html-preview.ts";

const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

test.each(["dark", "light"] as const)(
  "a %s preview draws chart series in six distinct colours that read on its background",
  (scheme) => {
    const theme = previewTheme(scheme);
    const background = rgb(theme.background);
    const series = ([1, 2, 3, 4, 5, 6] as const).map((n) => rgb(theme[`chart-${n}`]));
    for (const colour of series)
      expect(contrastRatio(colour, background)).toBeGreaterThanOrEqual(3);
    for (const [index, colour] of series.entries())
      for (const other of series.slice(index + 1))
        expect(deltaE(colour, other)).toBeGreaterThanOrEqual(10);
  },
);
