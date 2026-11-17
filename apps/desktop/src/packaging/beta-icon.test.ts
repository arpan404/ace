import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withBetaBand } from "./beta-icon.ts";

const master = readFileSync(join(import.meta.dirname, "../../build/icon.svg"), "utf8");

it("draws a BETA band over the shipped icon, inside its tile, and keeps the icon whole", () => {
  const body = master.slice(0, master.lastIndexOf("</svg>"));
  const beta = withBetaBand(master);
  expect(beta.startsWith(body)).toBe(true);
  // What comes after the master is the band alone: one group, clipped to the tile, with BETA.
  const band = beta
    .slice(body.length)
    .replace(/<\/svg>\s*$/, "")
    .trim();
  expect(band).toMatch(/^<g clip-path="url\(#clip\)"[^>]*>[\s\S]*>BETA<\/text>\s*<\/g>$/);
  expect(band.match(/<g\b/g)).toHaveLength(1);
});

it("refuses a master it can't band, rather than ship a beta that looks stable", () => {
  expect(() => withBetaBand('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow();
});
