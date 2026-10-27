import { expect, test } from "vitest";
import { pageKey } from "./page-keys.ts";
import { zoomForKey, zoomIn, zoomOut } from "@ace/ui-core";

const press = (key: string, code: string, extra: Partial<Parameters<typeof pageKey>[0]> = {}) =>
  pageKey({ key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

test("zoom keys step through a browser's levels and ⌘0 goes back to 100%", () => {
  expect(zoomIn(1)).toBe(1.1);
  expect(zoomOut(1)).toBe(0.9);
  expect(zoomIn(1.05)).toBe(1.1);
  expect(zoomIn(5)).toBe(5);
  expect(zoomOut(0.25)).toBe(0.25);
  expect(zoomForKey("0", 2)).toBe(1);
  expect(press("+", "Equal", { shiftKey: true })).toBe("zoomIn");
  expect(press("=", "Equal")).toBe("zoomIn");
  expect(press("-", "Minus")).toBe("zoomOut");
  expect(press("i", "KeyI", { altKey: true })).toBe("devtools");
  expect(press("u", "KeyU", { altKey: true })).toBe("source");
  expect(press("p", "KeyP")).toBe("print");
  // Keys without ⌘ or Ctrl go to the page.
  expect(
    pageKey({
      key: "p",
      code: "KeyP",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
  ).toBeUndefined();
});
