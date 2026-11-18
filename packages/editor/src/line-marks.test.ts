import { beforeAll, describe, expect, it } from "vitest";
import { lineMarks } from "./line-marks.ts";
import { initForTests } from "./test-support.ts";

beforeAll(initForTests);

/** These cases are the Rust crate's own, so both sides of the boundary agree on a mark. */
describe("lineMarks", () => {
  it("marks an inserted line that only the current text has", () => {
    expect(lineMarks("a\nb\n", "a\nnew\nb\n")).toEqual([{ line: 2, kind: "added" }]);
  });

  it("marks a rewritten block modified and the leftover removal below it", () => {
    expect(lineMarks("a\nx\ny\nb\n", "a\nX\nb\n")).toEqual([
      { line: 2, kind: "modified" },
      { line: 3, kind: "removed" },
    ]);
  });
});
