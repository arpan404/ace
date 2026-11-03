import { expect, it } from "vitest";
import { hunkRows, hunkTail } from "./review-hunk.ts";

const hunk = [
  "@@ -10,6 +10,7 @@ export function total()",
  " const a = 1;",
  " const b = 2;",
  "-const c = 3;",
  "+const c = 4;",
  "+const d = 5;",
  " const e = 6;",
  " return a + b;",
].join("\n");

it("a thread's long hunk keeps its last lines, still numbered as in the file", () => {
  const tail = hunkTail(hunk, 3);
  expect(tail).toBe("@@ -13,2 +13,3 @@\n+const d = 5;\n const e = 6;\n return a + b;");
  expect(hunkRows(tail).map((r) => [r.left, r.right, r.text])).toEqual([
    [undefined, 13, "const d = 5;"],
    [13, 14, "const e = 6;"],
    [14, 15, "return a + b;"],
  ]);
});

it("a short hunk is kept whole with its lines numbered", () => {
  expect(hunkRows(hunkTail(hunk)).map((r) => r.right ?? r.left)).toEqual([
    10, 11, 12, 12, 13, 14, 15,
  ]);
});

it("a hunk GitHub sent without a header reads as missing", () => {
  expect(hunkTail("const a = 1;\n+b")).toBeUndefined();
  expect(hunkRows(undefined)).toEqual([]);
});
