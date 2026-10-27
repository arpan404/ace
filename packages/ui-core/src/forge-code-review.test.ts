import { expect, test } from "vitest";
import { lineRangeAnchor, viewedMarks } from "./forge-code-review.ts";
import { splitPairs } from "./diff.ts";

const head = "a".repeat(40);
const review = {
  headSha: head,
  viewed: [
    { path: "a.ts", state: "VIEWED" },
    { path: "b.ts", state: "DISMISSED" },
    { path: "c.ts", state: "UNVIEWED" },
  ],
};

test("All commits at the reviewed head shows each file's mark, a dismissed one as changed since viewed", () => {
  const marks = viewedMarks(review, { headSha: head });
  expect(marks.availability).toBe("available");
  expect(marks.count).toBe(1);
  expect(marks.of("a.ts")).toEqual({ checked: true, changed: false });
  expect(marks.of("b.ts")).toEqual({ checked: false, changed: true });
  expect(marks.of("c.ts")).toEqual({ checked: false, changed: false });
  expect(marks.of("d.ts")).toBeUndefined();
});

test("one commit shows no marks and says they belong to All commits", () => {
  const marks = viewedMarks(review, { headSha: head, commit: "b".repeat(40) });
  expect(marks.availability).toBe("all-commits-only");
  expect(marks.count).toBeUndefined();
  expect(marks.of("a.ts")).toBeUndefined();
});

test("marks read at an older head never show on a newer one", () => {
  const marks = viewedMarks(review, { headSha: "c".repeat(40) });
  expect(marks.availability).toBe("unavailable");
  expect(marks.of("a.ts")).toBeUndefined();
});

test("a span of picked lines anchors at its last line and starts at its first", () => {
  expect(lineRangeAnchor("a.ts", { side: "new", start: 3, end: 6 }, head)).toEqual({
    commit: head,
    path: "a.ts",
    line: 6,
    side: "RIGHT",
    startLine: 3,
    startSide: "RIGHT",
  });
  expect(lineRangeAnchor("a.ts", { side: "old", start: 4, end: 4 }, head)).toEqual({
    commit: head,
    path: "a.ts",
    line: 4,
    side: "LEFT",
  });
});

test("side by side, a change's removed and added lines share rows and other rows stand alone", () => {
  expect(splitPairs(["hunk", "context", "del", "del", "add", "context", "add"])).toEqual([
    { left: 0, right: 0 },
    { left: 1, right: 1 },
    { left: 2, right: 4 },
    { left: 3, right: null },
    { left: 5, right: 5 },
    { left: null, right: 6 },
  ]);
});
