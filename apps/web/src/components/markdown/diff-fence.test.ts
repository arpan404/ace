import { expect, test } from "vitest";
import { fenceDiffCached, parseFenceDiff } from "./diff-fence.ts";

const patch = [
  "diff --git a/src/replay.ts b/src/replay.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/replay.ts",
  "+++ b/src/replay.ts",
  "@@ -10,4 +10,5 @@ export function replay()",
  " const start = 0;",
  "-const end = 1;",
  "+const end = 2;",
  "+const cap = 200;",
  " return frames;",
].join("\n");

test("a unified diff keeps every line, numbers them from its hunk and counts its changes", () => {
  const diff = parseFenceDiff(patch);
  expect(diff.lines.map((line) => line.text).join("\n")).toBe(patch);
  expect(diff.file).toBe("src/replay.ts");
  expect({ additions: diff.additions, deletions: diff.deletions }).toEqual({
    additions: 2,
    deletions: 1,
  });
  expect(diff.numbered).toBe(true);
  expect(diff.lines.map((line) => [line.kind, line.old, line.new])).toEqual([
    ["meta", undefined, undefined],
    ["meta", undefined, undefined],
    ["meta", undefined, undefined],
    ["meta", undefined, undefined],
    ["hunk", undefined, undefined],
    ["context", 10, 10],
    ["del", 11, undefined],
    ["add", undefined, 11],
    ["add", undefined, 12],
    ["context", 12, 13],
  ]);
});

test("a diff an agent wrote without headers still reads as changes, unnumbered", () => {
  const diff = parseFenceDiff("-old line\n+new line\n unchanged");
  expect(diff.lines.map((line) => line.kind)).toEqual(["del", "add", "context"]);
  expect(diff.numbered).toBe(false);
  expect(diff.file).toBeUndefined();
});

test("a removed line that starts with dashes inside a hunk is a change, not a header", () => {
  const diff = parseFenceDiff("@@ -1,2 +1,1 @@\n--- a comment\n kept");
  expect(diff.lines.map((line) => line.kind)).toEqual(["hunk", "del", "context"]);
  expect(diff.deletions).toBe(1);
});

test("the same diff text is parsed once however often it mounts", () => {
  expect(fenceDiffCached(patch)).toBe(fenceDiffCached(patch));
});
