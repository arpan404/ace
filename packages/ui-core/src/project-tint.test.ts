import { expect, test } from "vitest";
import { projectTint, projectTintCount } from "./project-tint.ts";

test("a project's tint is pinned across releases, so no device or upgrade recolours it", () => {
  // Changing the hash or the palette size would repaint every badge people know by colour.
  expect(
    ["ws-billing-api", "ws-ace", "/Users/me/code/relay", "ws-ace-mobile", "docs"].map(projectTint),
  ).toEqual([9, 10, 2, 11, 7]);
});

test("every tint is one the themes define", () => {
  for (let i = 0; i < 500; i++) {
    const tint = projectTint(`project-${i}`);
    expect(tint).toBeGreaterThanOrEqual(1);
    expect(tint).toBeLessThanOrEqual(projectTintCount);
  }
});

test("projects spread across the whole palette rather than bunching on a few tints", () => {
  const used = new Set(Array.from({ length: 120 }, (_, i) => projectTint(`ws-${i}`)));
  expect(used.size).toBe(projectTintCount);
});

test("similar ids usually get different tints", () => {
  const tints = ["ace", "ace-mobile", "ace-web", "ace-docs"].map(projectTint);
  expect(new Set(tints).size).toBeGreaterThanOrEqual(3);
});
