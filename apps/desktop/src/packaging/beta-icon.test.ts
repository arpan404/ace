import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withBetaBand } from "./beta-icon.ts";

const master = readFileSync(join(import.meta.dirname, "../../build/icon.svg"), "utf8");

it("draws a BETA band over the shipped icon, inside its tile, and keeps the icon whole", () => {
  const beta = withBetaBand(master);
  expect(beta.startsWith(master.slice(0, master.lastIndexOf("</svg>")))).toBe(true);
  expect(beta.trimEnd().endsWith("</svg>")).toBe(true);
  expect(beta).toMatch(/<g clip-path="url\(#clip\)"[^>]*>[\s\S]*>BETA<\/text>/);
});

it("refuses a master it can't band, rather than ship a beta that looks stable", () => {
  expect(() => withBetaBand('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow();
});
