import { expect, test } from "vitest";
import { treeLayout } from "./files-state.ts";

test("beside a file the tree shows only while the source keeps 420px, else it steps aside", () => {
  expect(treeLayout(900, 240, { file: true, chosen: undefined })).toBe("beside");
  expect(treeLayout(520, 240, { file: true, chosen: undefined })).toBe("hidden");
});

test("asked for in a narrow tab, the tree opens over the file", () => {
  expect(treeLayout(520, 240, { file: true, chosen: true })).toBe("over");
});

test("an empty tab shows the tree beside its empty state at any width, unless hidden by hand", () => {
  expect(treeLayout(520, 240, { file: false, chosen: undefined })).toBe("beside");
  expect(treeLayout(520, 240, { file: false, chosen: false })).toBe("hidden");
  expect(treeLayout(1200, 240, { file: true, chosen: false })).toBe("hidden");
});
