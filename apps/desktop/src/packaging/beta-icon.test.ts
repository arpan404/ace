import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { betaIcon } from "./beta-icon.ts";

const master = readFileSync(join(import.meta.dirname, "../../build/icon.svg"), "utf8");

/** Every point a path's outline passes through or bends toward, on the 1024 canvas. */
function points(d: string): Array<[number, number]> {
  const numbers = [...d.matchAll(/-?\d*\.?\d+/g)].map(([n]) => Number(n));
  return numbers.flatMap((x, at) => (at % 2 === 0 ? [[x, numbers[at + 1] ?? 0]] : []));
}

it("keeps the whole stable icon and peels only its bottom-right corner, with no lettering", () => {
  const body = master.slice(0, master.lastIndexOf("</svg>"));
  const beta = betaIcon(master);
  expect(beta.startsWith(body)).toBe(true);
  const peel = beta.slice(body.length);
  expect(peel).not.toMatch(/<text\b/);
  const shapes = [...peel.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(([, d]) => d ?? "");
  expect(shapes.length).toBeGreaterThan(0);
  // The mark's lower-right tip sits near x + y = 1465. Every curve stays inside its control
  // points, so points all beyond 1480 mean the peel never covers the mark.
  for (const [x, y] of shapes.flatMap(points)) expect(x + y).toBeGreaterThan(1480);
});

it("shows the peeled-back corner inside the tile's own rounded shape", () => {
  const peel = betaIcon(master).slice(master.lastIndexOf("</svg>"));
  expect(peel).toMatch(/<path\b[^>]*clip-path="url\(#clip\)"/);
});

it("refuses a master it can't peel, rather than ship a beta that looks stable", () => {
  expect(() => betaIcon('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow();
});
