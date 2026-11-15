import { expect, test } from "vitest";
import { contrastRatio, over, parseOpaqueColor } from "@ace/themes";
import { clampReveal, defaultSuitReveal, revealCeiling } from "./reveal.ts";

const rgb = (hex: string) => {
  const parsed = parseOpaqueColor(hex);
  if (!parsed) throw new Error(hex);
  return parsed;
};

test("a region without a reveal keeps ace's look, whatever the ceiling", () => {
  expect(clampReveal({}, "transcript", 0)).toBe(defaultSuitReveal.transcript);
  expect(clampReveal({ reveal: { sidebar: 0.4 } }, "app", 0)).toBe(defaultSuitReveal.app);
});

test("a Suit's reveal is held under the ceiling its text allows", () => {
  expect(clampReveal({ reveal: { transcript: 0.9 } }, "transcript", 0.5)).toBe(0.5);
  expect(clampReveal({ reveal: { transcript: 0.2 } }, "transcript", 0.5)).toBe(0.2);
  expect(clampReveal({ reveal: { sidebar: 0.8 } }, "sidebar", 1.4)).toBe(0.8);
});

test("the ceiling is the most a surface can thin and still read over every backdrop", () => {
  const region = { text: "#f2f2f2", surface: "#101014", backdrops: [rgb("#ffffff")] };
  const ceiling = revealCeiling(region);
  expect(ceiling).toBeGreaterThan(0);
  expect(ceiling).toBeLessThan(1);
  const at = (reveal: number) =>
    contrastRatio(rgb("#f2f2f2"), over(rgb("#101014"), 1 - reveal, rgb("#ffffff")));
  expect(at(ceiling)).toBeGreaterThanOrEqual(4.5);
  expect(at(ceiling + 0.01)).toBeLessThan(4.5);
});

test("a backdrop that matches the surface lets the region reveal fully", () => {
  expect(revealCeiling({ text: "#f2f2f2", surface: "#101014", backdrops: [rgb("#101014")] })).toBe(
    1,
  );
});

test("without sampled frames the ceiling holds against both black and white", () => {
  const sampled = revealCeiling({
    text: "#f2f2f2",
    surface: "#101014",
    backdrops: [rgb("#000000")],
  });
  const unknown = revealCeiling({ text: "#f2f2f2", surface: "#101014" });
  expect(unknown).toBeLessThan(sampled);
});

test("text that can't read even on a solid surface allows no reveal", () => {
  expect(revealCeiling({ text: "#777777", surface: "#808080" })).toBe(0);
  expect(revealCeiling({ text: "not a colour", surface: "#808080" })).toBe(0);
});
