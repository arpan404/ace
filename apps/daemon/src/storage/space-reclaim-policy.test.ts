import { expect, test } from "vitest";
import { worthReclaiming } from "./space-reclaim-policy.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

test("a large database with a few free pages is left alone", () => {
  // About 230 free 4 KiB pages in a 13 GiB file.
  expect(worthReclaiming({ fileBytes: 13 * GiB, freeBytes: 230 * 4096 })).toBe(false);
  expect(worthReclaiming({ fileBytes: 13 * GiB, freeBytes: 63 * MiB })).toBe(false);
});

test("free pages are reclaimed once they reach 64 MiB, whatever the file size", () => {
  expect(worthReclaiming({ fileBytes: 13 * GiB, freeBytes: 64 * MiB })).toBe(true);
});

test("a tenth of the file free is reclaimed, but never under 1 MiB", () => {
  expect(worthReclaiming({ fileBytes: 40 * MiB, freeBytes: 4 * MiB })).toBe(true);
  expect(worthReclaiming({ fileBytes: 40 * MiB, freeBytes: 3 * MiB })).toBe(false);
  expect(worthReclaiming({ fileBytes: 2 * MiB, freeBytes: 1024 * 1024 - 4096 })).toBe(false);
});
