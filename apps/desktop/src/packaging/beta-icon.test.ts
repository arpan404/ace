import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { betaIcon } from "./beta-icon.ts";

const master = readFileSync(join(import.meta.dirname, "../../build/icon.svg"), "utf8");

/** Mean relative luminance (0 dark to 1 light) of a gradient's stop colours. */
function lightness(svg: string, id: string): number {
  const gradient = svg.match(
    new RegExp(`<linearGradient\\b[^>]*\\bid="${id}"[\\s\\S]*?</linearGradient>`),
  );
  const colours = [...(gradient?.[0] ?? "").matchAll(/stop-color="#([0-9a-f]{6})"/gi)].map(
    ([, hex]) => hex ?? "",
  );
  if (colours.length === 0) throw new Error(`no stops in #${id}`);
  const sum = colours.reduce((total, hex) => {
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
    return total + 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }, 0);
  return sum / colours.length;
}

/** Every path's outline, in order. */
function shapes(svg: string): Array<string | undefined> {
  return [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(([, d]) => d);
}

it("turns stable's dark tile and light wings into a light tile with dark wings", () => {
  const beta = betaIcon(master);
  // Wings minus tile: strongly positive on stable, strongly negative on the beta.
  expect(lightness(master, "ink") - lightness(master, "fill")).toBeGreaterThan(0.6);
  expect(lightness(beta, "fill") - lightness(beta, "ink")).toBeGreaterThan(0.6);
});

it("keeps the stable tile and mark shapes, and adds no lettering", () => {
  const beta = betaIcon(master);
  expect(shapes(beta)).toEqual(shapes(master));
  expect(beta).not.toMatch(/<text\b/);
});

it("refuses a master it can't repaint, rather than ship a beta that looks stable", () => {
  expect(() => betaIcon('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow();
});
