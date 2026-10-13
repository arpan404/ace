import { expect, test } from "vitest";
import { themeProperties } from "@ace/html";
import { contrastRatio, deltaE, parseOpaqueColor } from "./colour.ts";
import { themeDeclarations } from "./css.ts";
import { themeIds } from "./palettes.ts";

const rgb = (value: string | undefined) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

test("every theme gives chat visualizations six distinct chart colours that read on its background", () => {
  const series = themeProperties.filter((name) => name.startsWith("chart-"));
  expect(series).toHaveLength(6);
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const tokens = themeDeclarations(id, scheme);
      const background = rgb(tokens["--background"]);
      const colours = series.map((name) => rgb(tokens[`--${name}`]));
      for (const colour of colours)
        expect(contrastRatio(colour, background), `${id} ${scheme}`).toBeGreaterThanOrEqual(3);
      for (const [index, colour] of colours.entries())
        for (const other of colours.slice(index + 1))
          expect(deltaE(colour, other), `${id} ${scheme}`).toBeGreaterThanOrEqual(10);
    }
});
