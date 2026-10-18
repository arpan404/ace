import { expect, it } from "vitest";
import { nextZoom, zoomChord } from "./zoom.ts";

it("zoom steps by 1.2 within 25% and 500%, and in then out comes back to 100%", () => {
  expect(nextZoom(1, "in")).toBeCloseTo(1.2);
  expect(nextZoom(nextZoom(1, "in"), "out")).toBe(1);
  let zoom = 1;
  for (let step = 0; step < 20; step++) zoom = nextZoom(zoom, "in");
  expect(zoom).toBe(5);
  for (let step = 0; step < 40; step++) zoom = nextZoom(zoom, "out");
  expect(zoom).toBe(0.25);
  expect(nextZoom(3, "reset")).toBe(1);
});

const key = (name: string, modifiers: number) =>
  ({ kind: "key", event: "keyDown", key: name, modifiers }) as const;

it("only ⌘ or Ctrl with + = - 0 zooms; the page gets every other key", () => {
  expect(zoomChord(key("=", 4))).toBe("in");
  expect(zoomChord(key("+", 2 | 8))).toBe("in");
  expect(zoomChord(key("-", 2))).toBe("out");
  expect(zoomChord(key("0", 4))).toBe("reset");
  expect(zoomChord(key("=", 0))).toBeUndefined();
  expect(zoomChord(key("=", 4 | 1))).toBeUndefined();
  expect(zoomChord(key("a", 4))).toBeUndefined();
});
