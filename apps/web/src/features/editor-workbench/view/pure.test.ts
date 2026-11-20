import { expect, test } from "vitest";
import { dropZone } from "./drop-zone.ts";
import { tabHints } from "./paths.ts";

const box = { left: 100, top: 0, width: 300, height: 300 };

test.each([
  [{ x: 380, y: 150 }, "right"],
  [{ x: 120, y: 150 }, "left"],
  [{ x: 250, y: 20 }, "up"],
  [{ x: 250, y: 290 }, "down"],
  [{ x: 250, y: 150 }, "center"],
  [{ x: 300, y: 150 }, "center"],
  // A corner goes to the side the point is proportionally nearer.
  [{ x: 390, y: 40 }, "right"],
] as const)("a tab dropped at %o lands %s", (point, zone) => {
  expect(dropZone(point, box)).toBe(zone);
});

test("a zero-sized group takes every drop in its middle", () => {
  expect(dropZone({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBe("center");
});

test.each([
  [
    ["a/b.ts", "c/d.ts"],
    [undefined, undefined],
  ],
  [
    ["x/panels/index.ts", "x/shell/index.ts"],
    ["panels", "shell"],
  ],
  // The nearest folder is shared: the hint walks up to the first one that differs.
  [
    ["web/src/index.ts", "ios/src/index.ts"],
    ["web", "ios"],
  ],
  [
    ["index.ts", "lib/index.ts"],
    ["/", "lib"],
  ],
])("tab hints for %o are %o", (paths, hints) => {
  const found = tabHints(paths);
  expect(paths.map((path) => found.get(path))).toEqual(hints);
});
